/**
 * ローカルリレーサーバーを実行すると、APIキーを隠し、
 * サーバー上でカスタムロジックを実行できます。
 *
 * ローカルリレーサーバーのアドレスを設定します：
 * REACT_APP_LOCAL_RELAY_SERVER_URL=http://localhost:8081
 *
 * これにより、`.env`ファイルにOPENAI_API_KEY=を設定する必要があります。
 * `npm run relay`で実行し、`npm start`と並行して動かせます。
 */
const LOCAL_RELAY_SERVER_URL: string =
  process.env.REACT_APP_LOCAL_RELAY_SERVER_URL || '';

import { useEffect, useRef, useCallback, useState } from 'react';

import { RealtimeClient } from '@openai/realtime-api-beta';
import { ItemType } from '@openai/realtime-api-beta/dist/lib/client.js';
import { WavRecorder, WavStreamPlayer } from '../lib/wavtools/index.js';
import { instructions } from '../utils/conversation_config.js';
import { WavRenderer } from '../utils/wav_renderer';

import { X, Edit, Zap, ArrowUp, ArrowDown } from 'react-feather';
import { Button } from '../components/button/Button';
import { Toggle } from '../components/toggle/Toggle';
import { Map } from '../components/Map';

import './ConsolePage.scss';
import { isJsxOpeningLikeElement } from 'typescript';

/**
 * get_weather()関数呼び出しからの結果の型
 */
interface Coordinates {
  lat: number;
  lng: number;
  location?: string;
  temperature?: {
    value: number;
    units: string;
  };
  wind_speed?: {
    value: number;
    units: string;
  };
}

/**
 * すべてのイベントログの型
 */
interface RealtimeEvent {
  time: string;
  source: 'client' | 'server';
  count?: number;
  event: { [key: string]: any };
}

export function ConsolePage() {
  /**
   * ユーザーにAPIキーを尋ねる
   * ローカルリレーサーバーを使用している場合、これは必要ありません
   */
  const apiKey = LOCAL_RELAY_SERVER_URL
    ? ''
    : localStorage.getItem('tmp::voice_api_key') ||
      prompt('OpenAI API Key') ||
      '';
  if (apiKey !== '') {
    localStorage.setItem('tmp::voice_api_key', apiKey);
  }

  /**
   * インスタンス化：
   * - WavRecorder（音声入力）
   * - WavStreamPlayer（音声出力）
   * - RealtimeClient（APIクライアント）
   */
  const wavRecorderRef = useRef<WavRecorder>(
    new WavRecorder({ sampleRate: 24000 })
  );
  const wavStreamPlayerRef = useRef<WavStreamPlayer>(
    new WavStreamPlayer({ sampleRate: 24000 })
  );
  const clientRef = useRef<RealtimeClient>(
    new RealtimeClient(
      LOCAL_RELAY_SERVER_URL
        ? { url: LOCAL_RELAY_SERVER_URL }
        : {
            apiKey: apiKey,
            dangerouslyAllowAPIKeyInBrowser: true,
          }
    )
  );

  /**
   * 以下の参照：
   * - オーディオビジュアライゼーションのレンダリング（canvas）
   * - イベントログの自動スクロール
   * - イベントログ表示のタイミングデルタ
   */
  const clientCanvasRef = useRef<HTMLCanvasElement>(null);
  const serverCanvasRef = useRef<HTMLCanvasElement>(null);
  const eventsScrollHeightRef = useRef(0);
  const eventsScrollRef = useRef<HTMLDivElement>(null);
  const startTimeRef = useRef<string>(new Date().toISOString());

  /**
   * アプリケーション状態を表示するためのすべての変数
   * - itemsはすべての会話項目（ダイアログ）
   * - realtimeEventsはイベントログで、展開可能
   * - memoryKvはset_memory()関数用
   * - coords、markerはget_weather()関数用
   */
  const [items, setItems] = useState<ItemType[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<RealtimeEvent[]>([]);
  const [expandedEvents, setExpandedEvents] = useState<{
    [key: string]: boolean;
  }>({});
  const [isConnected, setIsConnected] = useState(false);
  const [canPushToTalk, setCanPushToTalk] = useState(true);
  const [isRecording, setIsRecording] = useState(false);
  const [memoryKv, setMemoryKv] = useState<{ [key: string]: any }>({});
  const [coords, setCoords] = useState<Coordinates | null>({
    lat: 37.775593,
    lng: -122.418137,
  });
  const [marker, setMarker] = useState<Coordinates | null>(null);

  // --- 予約日時モーダル用の状態変数を追加 ---
  const [reserveDates, setReserveDates] = useState<
    { row: number; date: string }[]
  >([]);
  const [showReserveModal, setShowReserveModal] = useState(false);
  const [selectedReserveDate, setSelectedReserveDate] = useState<number | null>(
    null
  );
  // --------------------------------------------

  /**
   * ログのタイミングをフォーマットするユーティリティ
   */
  const formatTime = useCallback((timestamp: string) => {
    const startTime = startTimeRef.current;
    const t0 = new Date(startTime).valueOf();
    const t1 = new Date(timestamp).valueOf();
    const delta = t1 - t0;
    const hs = Math.floor(delta / 10) % 100;
    const s = Math.floor(delta / 1000) % 60;
    const m = Math.floor(delta / 60_000) % 60;
    const pad = (n: number) => {
      let s = n + '';
      while (s.length < 2) {
        s = '0' + s;
      }
      return s;
    };
    return `${pad(m)}:${pad(s)}.${pad(hs)}`;
  }, []);

  /**
   * APIキーをクリックしたとき
   */
  const resetAPIKey = useCallback(() => {
    const apiKey = prompt('OpenAI API Key');
    if (apiKey !== null) {
      localStorage.clear();
      localStorage.setItem('tmp::voice_api_key', apiKey);
      window.location.reload();
    }
  }, []);

  /**
   * 会話に接続：
   * WavRecorderは音声入力、WavStreamPlayerは音声出力、clientはAPIクライアント
   */
  const connectConversation = useCallback(async () => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;

    // 状態変数を設定
    startTimeRef.current = new Date().toISOString();
    setIsConnected(true);
    setRealtimeEvents([]);
    setItems(client.conversation.getItems());

    // マイクに接続
    await wavRecorder.begin();

    // オーディオ出力に接続
    await wavStreamPlayer.connect();

    // Realtime APIに接続
    await client.connect();
    client.sendUserMessageContent([
      {
        type: `input_text`,
        text: `こんにちは、新宿HANIKAの問い合わせ窓口です。何かお困りでしょうか？と答えて`,
      },
    ]);

    if (client.getTurnDetectionType() === 'server_vad') {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
  }, []);

  /**
   * 会話を切断し、状態をリセット
   */
  const disconnectConversation = useCallback(async () => {
    setIsConnected(false);
    setRealtimeEvents([]);
    setItems([]);
    setMemoryKv({});
    setCoords({
      lat: 37.775593,
      lng: -122.418137,
    });
    setMarker(null);

    const client = clientRef.current;
    client.disconnect();

    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.end();

    const wavStreamPlayer = wavStreamPlayerRef.current;
    await wavStreamPlayer.interrupt();
  }, []);

  const deleteConversationItem = useCallback(async (id: string) => {
    const client = clientRef.current;
    client.deleteItem(id);
  }, []);

  /**
   * プッシュトゥトークモードで録音を開始
   * 各サンプルに対して.appendInputAudio()を実行
   */
  const startRecording = async () => {
    setIsRecording(true);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const trackSampleOffset = await wavStreamPlayer.interrupt();
    if (trackSampleOffset?.trackId) {
      const { trackId, offset } = trackSampleOffset;
      await client.cancelResponse(trackId, offset);
    }
    await wavRecorder.record((data) => client.appendInputAudio(data.mono));
  };

  /**
   * プッシュトゥトークモードで録音を停止
   */
  const stopRecording = async () => {
    setIsRecording(false);
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    await wavRecorder.pause();
    client.createResponse();
  };

  /**
   * 通信の手動モードとVADモードを切り替え
   */
  const changeTurnEndType = async (value: string) => {
    const client = clientRef.current;
    const wavRecorder = wavRecorderRef.current;
    if (value === 'none' && wavRecorder.getStatus() === 'recording') {
      await wavRecorder.pause();
    }
    client.updateSession({
      turn_detection: value === 'none' ? null : { type: 'server_vad' },
    });
    if (value === 'server_vad' && client.isConnected()) {
      await wavRecorder.record((data) => client.appendInputAudio(data.mono));
    }
    setCanPushToTalk(value === 'none');
  };

  /**
   * イベントログの自動スクロール
   */
  useEffect(() => {
    if (eventsScrollRef.current) {
      const eventsEl = eventsScrollRef.current;
      const scrollHeight = eventsEl.scrollHeight;
      // 高さが変わった場合のみスクロール
      if (scrollHeight !== eventsScrollHeightRef.current) {
        eventsEl.scrollTop = scrollHeight;
        eventsScrollHeightRef.current = scrollHeight;
      }
    }
  }, [realtimeEvents]);

  /**
   * 会話ログの自動スクロール
   */
  useEffect(() => {
    const conversationEls = [].slice.call(
      document.body.querySelectorAll('[data-conversation-content]')
    );
    for (const el of conversationEls) {
      const conversationEl = el as HTMLDivElement;
      conversationEl.scrollTop = conversationEl.scrollHeight;
    }
  }, [items]);

  /**
   * ビジュアライゼーション用のレンダーループを設定
   */
  useEffect(() => {
    let isLoaded = true;

    const wavRecorder = wavRecorderRef.current;
    const clientCanvas = clientCanvasRef.current;
    let clientCtx: CanvasRenderingContext2D | null = null;

    const wavStreamPlayer = wavStreamPlayerRef.current;
    const serverCanvas = serverCanvasRef.current;
    let serverCtx: CanvasRenderingContext2D | null = null;

    const render = () => {
      if (isLoaded) {
        if (clientCanvas) {
          if (!clientCanvas.width || !clientCanvas.height) {
            clientCanvas.width = clientCanvas.offsetWidth;
            clientCanvas.height = clientCanvas.offsetHeight;
          }
          clientCtx = clientCtx || clientCanvas.getContext('2d');
          if (clientCtx) {
            clientCtx.clearRect(0, 0, clientCanvas.width, clientCanvas.height);
            const result = wavRecorder.recording
              ? wavRecorder.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              clientCanvas,
              clientCtx,
              result.values,
              '#0099ff',
              10,
              0,
              8
            );
          }
        }
        if (serverCanvas) {
          if (!serverCanvas.width || !serverCanvas.height) {
            serverCanvas.width = serverCanvas.offsetWidth;
            serverCanvas.height = serverCanvas.offsetHeight;
          }
          serverCtx = serverCtx || serverCanvas.getContext('2d');
          if (serverCtx) {
            serverCtx.clearRect(0, 0, serverCanvas.width, serverCanvas.height);
            const result = wavStreamPlayer.analyser
              ? wavStreamPlayer.getFrequencies('voice')
              : { values: new Float32Array([0]) };
            WavRenderer.drawBars(
              serverCanvas,
              serverCtx,
              result.values,
              '#009900',
              10,
              0,
              8
            );
          }
        }
        window.requestAnimationFrame(render);
      }
    };
    render();

    return () => {
      isLoaded = false;
    };
  }, []);

  const GAS_ENDPOINT =
    'https://script.google.com/macros/s/AKfycbxiDH6zrESbgx5OIrfDST0xS5EyS21gx8Pb7eRfrwTzmMIaE-PUPzw9bp3zeaHb0zCs/exec';

  const GAS_ENDPOINT_RESERVE =
    'https://script.google.com/macros/s/AKfycbxkfq1e3bJF3Qg5MjG09O8EGhzmizINutjT1eeqQFz-IMGsbiB6tErp2SxTxDyTNF51/exec';

  /**
   * コアのRealtimeClientとオーディオキャプチャのセットアップ
   * すべてのinstructions、tools、eventsなどを設定
   */
  useEffect(() => {
    // 参照を取得
    const wavStreamPlayer = wavStreamPlayerRef.current;
    const client = clientRef.current;

    // instructionsを設定
    client.updateSession({ instructions: instructions });
    // transcriptionを設定。これがないとユーザーのtranscriptionが戻ってきません
    client.updateSession({ input_audio_transcription: { model: 'whisper-1' } });

    // ツールを追加
    client.addTool(
      {
        name: 'set_memory',
        description: 'ユーザーに関する重要なデータをメモリに保存します。',
        parameters: {
          type: 'object',
          properties: {
            key: {
              type: 'string',
              description:
                'メモリ値のキー。常に小文字とアンダースコアを使用し、他の文字は使用しないでください。',
            },
            value: {
              type: 'string',
              description:
                '値は文字列として表現できるものであれば何でも可能です。',
            },
          },
          required: ['key', 'value'],
        },
      },
      async ({ key, value }: { [key: string]: any }) => {
        setMemoryKv((memoryKv) => {
          const newKv = { ...memoryKv };
          newKv[key] = value;
          return newKv;
        });
        return { ok: true };
      }
    );
    client.addTool(
      {
        name: 'get_weather',
        description:
          '指定された緯度経度の位置の天気を取得します。場所のラベルを指定してください。',
        parameters: {
          type: 'object',
          properties: {
            lat: {
              type: 'number',
              description: '緯度',
            },
            lng: {
              type: 'number',
              description: '経度',
            },
            location: {
              type: 'string',
              description: '場所の名前',
            },
          },
          required: ['lat', 'lng', 'location'],
        },
      },
      async ({ lat, lng, location }: { [key: string]: any }) => {
        setMarker({ lat, lng, location });
        setCoords({ lat, lng, location });
        const result = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,wind_speed_10m`
        );
        const json = await result.json();
        const temperature = {
          value: json.current.temperature_2m as number,
          units: json.current_units.temperature_2m as string,
        };
        const wind_speed = {
          value: json.current.wind_speed_10m as number,
          units: json.current_units.wind_speed_10m as string,
        };
        setMarker({ lat, lng, location, temperature, wind_speed });
        return json;
      }
    );
    client.addTool(
      {
        name: 'post_question',
        description: '患者様からの質問をスプレッドシートに投稿',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: '質問者氏名',
            },
            to: {
              type: 'string',
              description: '質問先',
            },
            content: {
              type: 'string',
              description: '質問内容',
            },
          },
          required: ['name', 'to', 'content'],
        },
      },
      async ({
        name,
        to,
        content,
      }: {
        name: string;
        to: string;
        content: string;
      }) => {
        const url = GAS_ENDPOINT;
        const params = new URLSearchParams({
          name: name,
          to: to,
          content: content,
        });

        try {
          const response = await fetch(`${url}?${params.toString()}`, {
            method: 'GET',
          });
          const responseData = await response.json();
          if (response.ok && responseData.result === 'success') {
            console.log(
              '質問が正常に送信されました。行番号:',
              responseData.row || 'unknown'
            );
            return { status: 200, rowNumber: responseData.row || 'unknown' };
          } else {
            console.error('エラーが発生しました:', responseData.error);
            return { status: response.status };
          }
        } catch (error) {
          console.error('その他のエラーが発生しました:', error);
          return { status: 500 };
        }
      }
    );
    client.addTool(
      {
        name: 'get_question_answer',
        description: '指定された行番号の質問に対する回答を取得',
        parameters: {
          type: 'object',
          properties: {
            row_number: {
              type: 'string',
              description: '回答を取得したい質問の行番号',
            },
          },
          required: ['row_number'],
        },
      },
      async ({ row_number }: { row_number: string }) => {
        const url = GAS_ENDPOINT;
        const params = new URLSearchParams({ row: row_number });
        try {
          const response = await fetch(`${url}?${params.toString()}`);
          const responseData = await response.json();
          if (response.ok && responseData.result === 'success') {
            return responseData.content; // F列の内容を返す
          } else {
            console.error('エラーが発生しました:', responseData.error);
            return null;
          }
        } catch (error) {
          console.error('リクエストエラーが発生しました:', error);
          return null;
        }
      }
    );
    // --- 'get_reserve_date'ツールをモーダル表示に修正 ---
    client.addTool(
      {
        name: 'get_reserve_date',
        description: '予約可能な日時一覧の取得',
        parameters: {
          type: 'object',
          properties: {
            // 必要なパラメータがあればここに追加
          },
        },
      },
      async () => {
        const url = GAS_ENDPOINT_RESERVE;
        try {
          const response = await fetch(url);
          const responseData = await response.json();
          if (response.ok && responseData.result === 'success') {
            setReserveDates(responseData.content); // 予約日時を設定
            setShowReserveModal(true); // モーダルを表示
            return responseData.content; // アシスタントに日時を返す
          } else {
            console.error('エラーが発生しました:', responseData.error);
            return null;
          }
        } catch (error) {
          console.error('リクエストエラーが発生しました:', error);
          return null;
        }
      }
    );
    // ------------------------------------------------
    client.addTool(
      {
        name: 'post_reserve',
        description: '番号を送信して予約を取る',
        parameters: {
          type: 'object',
          properties: {
            reserve_number: {
              type: 'string',
              description: 'ユーザーが予約したい日時の番号',
            },
          },
          required: ['reserve_number'],
        },
      },
      async ({ reserve_number }: { reserve_number: string }) => {
        const url = GAS_ENDPOINT_RESERVE;
        const params = new URLSearchParams({
          reserve_number: reserve_number,
        });
        try {
          const response = await fetch(`${url}?${params.toString()}`, {
            method: 'GET',
          });
          const responseData = await response.json();
          if (response.ok && responseData.result === 'success') {
            console.log('予約が正常に送信されました。');
            return { status: 200 };
          } else {
            console.error(
              'エラーが発生しました:',
              responseData.error || '不明なエラー'
            );
            return { status: response.status, error: responseData.error };
          }
        } catch (error) {
          console.error('その他のエラーが発生しました:', error);
          return { status: 500 };
        }
      }
    );

    // クライアントとサーバーからのリアルタイムイベントを処理してイベントログを記録
    client.on('realtime.event', (realtimeEvent: RealtimeEvent) => {
      setRealtimeEvents((realtimeEvents) => {
        const lastEvent = realtimeEvents[realtimeEvents.length - 1];
        if (lastEvent?.event.type === realtimeEvent.event.type) {
          // 同じイベントが連続して受信された場合、表示のためにそれらを集約
          lastEvent.count = (lastEvent.count || 0) + 1;
          return realtimeEvents.slice(0, -1).concat(lastEvent);
        } else {
          return realtimeEvents.concat(realtimeEvent);
        }
      });
    });
    client.on('error', (event: any) => console.error(event));
    client.on('conversation.interrupted', async () => {
      const trackSampleOffset = await wavStreamPlayer.interrupt();
      if (trackSampleOffset?.trackId) {
        const { trackId, offset } = trackSampleOffset;
        await client.cancelResponse(trackId, offset);
      }
    });
    client.on('conversation.updated', async ({ item, delta }: any) => {
      const items = client.conversation.getItems();
      if (delta?.audio) {
        wavStreamPlayer.add16BitPCM(delta.audio, item.id);
      }
      if (item.status === 'completed' && item.formatted.audio?.length) {
        const wavFile = await WavRecorder.decode(
          item.formatted.audio,
          24000,
          24000
        );
        item.formatted.file = wavFile;
      }
      setItems(items);
    });

    setItems(client.conversation.getItems());

    return () => {
      // クリーンアップ；デフォルトにリセット
      client.reset();
    };
  }, []);

  // --- 予約日時の送信を処理する関数を追加 ---
  const handleReserveDateSubmit = () => {
    const client = clientRef.current;
    // モーダルを閉じる
    setShowReserveModal(false);
    // 選択した日時の行番号を送信
    if (selectedReserveDate !== null) {
      client.sendUserMessageContent([
        {
          type: 'input_text',
          text: selectedReserveDate.toString(), // 行番号を文字列として送信
        },
      ]);
    }
  };
  // --------------------------------------------

  /**
   * アプリケーションをレンダリング
   */
  return (
    <div data-component="ConsolePage">
      <div className="content-top">
        <div className="content-title">
          <img src="/openai-logomark.svg" />
          <span>realtime console</span>
        </div>
        <div className="content-api-key">
          {!LOCAL_RELAY_SERVER_URL && (
            <Button
              icon={Edit}
              iconPosition="end"
              buttonStyle="flush"
              label={`api key: ${apiKey.slice(0, 3)}...`}
              onClick={() => resetAPIKey()}
            />
          )}
        </div>
      </div>
      <div className="content-main">
        <div className="content-logs">
          <div className="content-block events">
            <div className="visualization">
              <div className="visualization-entry client">
                <canvas ref={clientCanvasRef} />
              </div>
              <div className="visualization-entry server">
                <canvas ref={serverCanvasRef} />
              </div>
            </div>
            <div className="content-block-title">events</div>
            <div className="content-block-body" ref={eventsScrollRef}>
              {!realtimeEvents.length && `awaiting connection...`}
              {realtimeEvents.map((realtimeEvent, i) => {
                const count = realtimeEvent.count;
                const event = { ...realtimeEvent.event };
                if (event.type === 'input_audio_buffer.append') {
                  event.audio = `[trimmed: ${event.audio.length} bytes]`;
                } else if (event.type === 'response.audio.delta') {
                  event.delta = `[trimmed: ${event.delta.length} bytes]`;
                }
                return (
                  <div className="event" key={event.event_id}>
                    <div className="event-timestamp">
                      {formatTime(realtimeEvent.time)}
                    </div>
                    <div className="event-details">
                      <div
                        className="event-summary"
                        onClick={() => {
                          // イベント詳細の表示切り替え
                          const id = event.event_id;
                          const expanded = { ...expandedEvents };
                          if (expanded[id]) {
                            delete expanded[id];
                          } else {
                            expanded[id] = true;
                          }
                          setExpandedEvents(expanded);
                        }}
                      >
                        <div
                          className={`event-source ${
                            event.type === 'error'
                              ? 'error'
                              : realtimeEvent.source
                          }`}
                        >
                          {realtimeEvent.source === 'client' ? (
                            <ArrowUp />
                          ) : (
                            <ArrowDown />
                          )}
                          <span>
                            {event.type === 'error'
                              ? 'error!'
                              : realtimeEvent.source}
                          </span>
                        </div>
                        <div className="event-type">
                          {event.type}
                          {count && ` (${count})`}
                        </div>
                      </div>
                      {!!expandedEvents[event.event_id] && (
                        <div className="event-payload">
                          {JSON.stringify(event, null, 2)}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-block conversation">
            <div className="content-block-title">conversation</div>
            <div className="content-block-body" data-conversation-content>
              {!items.length && `awaiting connection...`}
              {items.map((conversationItem, i) => {
                return (
                  <div className="conversation-item" key={conversationItem.id}>
                    <div className={`speaker ${conversationItem.role || ''}`}>
                      <div>
                        {(
                          conversationItem.role || conversationItem.type
                        ).replaceAll('_', ' ')}
                      </div>
                      <div
                        className="close"
                        onClick={() =>
                          deleteConversationItem(conversationItem.id)
                        }
                      >
                        <X />
                      </div>
                    </div>
                    <div className={`speaker-content`}>
                      {/* ツールのレスポンス */}
                      {conversationItem.type === 'function_call_output' && (
                        <div>{conversationItem.formatted.output}</div>
                      )}
                      {/* ツールの呼び出し */}
                      {!!conversationItem.formatted.tool && (
                        <div>
                          {conversationItem.formatted.tool.name}(
                          {conversationItem.formatted.tool.arguments})
                        </div>
                      )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'user' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              (conversationItem.formatted.audio?.length
                                ? '(awaiting transcript)'
                                : conversationItem.formatted.text ||
                                  '(item sent)')}
                          </div>
                        )}
                      {!conversationItem.formatted.tool &&
                        conversationItem.role === 'assistant' && (
                          <div>
                            {conversationItem.formatted.transcript ||
                              conversationItem.formatted.text ||
                              '(truncated)'}
                          </div>
                        )}
                      {conversationItem.formatted.file && (
                        <audio
                          src={conversationItem.formatted.file.url}
                          controls
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="content-actions">
            <Toggle
              defaultValue={false}
              labels={['manual', 'vad']}
              values={['none', 'server_vad']}
              onChange={(_, value) => changeTurnEndType(value)}
            />
            <div className="spacer" />
            {isConnected && canPushToTalk && (
              <Button
                label={isRecording ? 'release to send' : 'push to talk'}
                buttonStyle={isRecording ? 'alert' : 'regular'}
                disabled={!isConnected || !canPushToTalk}
                onMouseDown={startRecording}
                onMouseUp={stopRecording}
              />
            )}
            <div className="spacer" />
            <Button
              label={isConnected ? 'disconnect' : 'connect'}
              iconPosition={isConnected ? 'end' : 'start'}
              icon={isConnected ? X : Zap}
              buttonStyle={isConnected ? 'regular' : 'action'}
              onClick={
                isConnected ? disconnectConversation : connectConversation
              }
            />
          </div>
        </div>
        <div className="content-right">
          <div className="content-block map">
            <div className="content-block-title">get_weather()</div>
            <div className="content-block-title bottom">
              {marker?.location || 'not yet retrieved'}
              {!!marker?.temperature && (
                <>
                  <br />
                  🌡️ {marker.temperature.value} {marker.temperature.units}
                </>
              )}
              {!!marker?.wind_speed && (
                <>
                  {' '}
                  🍃 {marker.wind_speed.value} {marker.wind_speed.units}
                </>
              )}
            </div>
            <div className="content-block-body full">
              {coords && (
                <Map
                  center={[coords.lat, coords.lng]}
                  location={coords.location}
                />
              )}
            </div>
          </div>
          <div className="content-block kv">
            <div className="content-block-title">set_memory()</div>
            <div className="content-block-body content-kv">
              {JSON.stringify(memoryKv, null, 2)}
            </div>
          </div>
        </div>
      </div>
      {/* --- 予約日時用のモーダルコンポーネントを追加 --- */}
      {showReserveModal && (
        <div className="modal">
          <div className="modal-content">
            <h2>予約可能な日時一覧</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleReserveDateSubmit();
              }}
            >
              {reserveDates.map((item, index) => (
                <div key={index}>
                  <input
                    type="radio"
                    id={`date-${index}`}
                    name="reserveDate"
                    value={item.row}
                    checked={selectedReserveDate === item.row}
                    onChange={() => setSelectedReserveDate(item.row)}
                  />
                  <label htmlFor={`date-${index}`}>{item.date}</label>
                </div>
              ))}
              <button type="submit">送信</button>
            </form>
          </div>
        </div>
      )}
      {/* ------------------------------------------- */}
    </div>
  );
}
