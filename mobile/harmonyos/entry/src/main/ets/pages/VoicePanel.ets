import { router } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { DictationController } from '../dictation/DictationController';

/**
 * Voice dictation debug panel (Phase 4a): start/stop dictation on the passed-in RPC
 * connection, with a live volume meter, transcript preview and a log list.
 *
 * Route params (in-memory object pass-through within the same UIAbility):
 * - hostId: string (required) — attribution only; the device token is NOT loaded here.
 * - rpc: SpikeRpcClient (required) — the caller's connected channel; this page never
 *   opens its own connection.
 *
 * Caller: router.pushUrl({ url: 'pages/VoicePanel', params: { hostId, rpc } }).
 * Integration note: register 'pages/VoicePanel' in
 * entry/src/main/resources/base/profile/main_pages.json when landing this file.
 */
@Entry
@Component
struct VoicePanel {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State recording: boolean = false;
  @State volume: number = 0;
  @State transcript: string = '';
  @State logs: string[] = [];
  @State channelReady: boolean = false;
  private hostId: string = '';
  private rpc: SpikeRpcClient | null = null;
  private controller: DictationController | null = null;

  appendLog(line: string): void {
    let stamped = `${new Date().toLocaleTimeString()}  ${line}`;
    let next = this.logs.slice();
    next.push(stamped);
    if (next.length > 200) {
      next.splice(0, next.length - 200);
    }
    this.logs = next;
  }

  aboutToAppear(): void {
    let params = router.getParams() as Record<string, Object>;
    let hostIdValue: Object = params['hostId'];
    this.hostId = typeof hostIdValue === 'string' ? hostIdValue : '';
    let rpcValue: Object = params['rpc'];
    if (rpcValue instanceof SpikeRpcClient) {
      this.rpc = rpcValue;
      this.channelReady = rpcValue.getState() === 'ready';
    }
    this.appendLog(this.hostId.length > 0
      ? `语音调试面板（host ${this.hostId}）`
      : '语音调试面板（未传 hostId）');
    if (this.rpc === null) {
      this.appendLog('未传入 RPC 连接 — 请从连接页携带 { hostId, rpc } 打开本页');
    }
  }

  aboutToDisappear(): void {
    if (this.controller) {
      this.controller.stop().catch((): void => {
      });
      this.controller = null;
    }
  }

  private newDictationId(): string {
    // Upstream format: mobile-dictation-<ts>-<random> (mobile-dictation-session-state.ts).
    let random = Math.floor(Math.random() * 2176782336).toString(36);
    return `mobile-dictation-${Date.now()}-${random}`;
  }

  async doStart(): Promise<void> {
    let rpc = this.rpc;
    if (!rpc) {
      this.appendLog('没有可用的 RPC 连接');
      return;
    }
    if (this.controller && this.controller.isRunning()) {
      this.appendLog('已经在录音');
      return;
    }
    let controller = new DictationController(getContext(this) as common.UIAbilityContext,
      (level: number): void => {
        this.volume = level;
      });
    controller.setLogSink((line: string): void => this.appendLog(line));
    controller.onTranscript = (text: string): void => {
      this.transcript = text;
    };
    this.controller = controller;
    this.transcript = '';
    let dictationId = this.newDictationId();
    this.appendLog(`开始听写 ${dictationId}`);
    let ok = await controller.start(dictationId, rpc);
    this.recording = ok;
  }

  async doStop(): Promise<void> {
    let controller = this.controller;
    if (!controller || !controller.isRunning()) {
      this.appendLog('当前没有录音');
      return;
    }
    await controller.stop();
    this.recording = false;
    this.volume = 0;
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('语音听写')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Text(this.channelReady ? '通道就绪' : '通道未就绪')
          .fontSize(12)
          .fontColor(this.channelReady ? this.themeAccent : this.themeWarning)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10 })

      Row({ space: 8 }) {
        Button(this.recording ? '停止听写' : '开始听写')
          .fontSize(12)
          .layoutWeight(1)
          .backgroundColor(this.recording ? '#5a2a2a' : '#2a6a5a')
          .onClick(() => {
            if (this.recording) {
              this.doStop();
            } else {
              this.doStart();
            }
          })
        Button('返回')
          .fontSize(12)
          .layoutWeight(1)
          .backgroundColor('#333333')
          .onClick(() => {
            router.back();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      Column({ space: 4 }) {
        Text('音量')
          .fontSize(11)
          .fontColor(this.themeSecondary)
        Progress({ value: Math.round(this.volume * 100), total: 100, type: ProgressType.Linear })
          .width('100%')
          .color(this.recording ? this.themeAccent : '#555555')
        Text(`峰值 ${(this.volume * 100).toFixed(0)}%`)
          .fontSize(10)
          .fontColor('#8a8a8a')
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      if (this.transcript.length > 0) {
        Column({ space: 4 }) {
          Text('识别文本')
            .fontSize(11)
            .fontColor(this.themeSecondary)
          Text(this.transcript)
            .fontSize(12)
            .fontColor(this.themeLink)
            .maxLines(4)
            .width('100%')
        }
        .width('100%')
        .alignItems(HorizontalAlign.Start)
        .padding({ left: 12, right: 12 })
      }

      List({ space: 2 }) {
        ForEach(this.logs, (line: string) => {
          ListItem() {
            Text(line)
              .fontSize(10)
              .fontColor('#a0c8a0')
              .maxLines(3)
          }
        }, (line: string, index: number) => `${index}-${line}`)
      }
      .layoutWeight(1)
      .width('100%')
      .padding({ left: 12, right: 12 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeBg)
  }
}
