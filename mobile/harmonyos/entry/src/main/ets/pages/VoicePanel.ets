import { uiText } from '../settings/NativeUi';
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
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeAccent') themeAccent: string = '#3276f2';
  @StorageProp('themeLink') themeLink: string = '#3276f2';
  @StorageProp('themeWarning') themeWarning: string = '#eab308';
  @State recording: boolean = false;
  @State volume: number = 0;
  @State transcript: string = '';
  @State logs: string[] = [];
  @State channelReady: boolean = false;
  @State starting: boolean = false;
  @State stopping: boolean = false;
  private disposed: boolean = false;
  private visible: boolean = true;
  private captureEpoch: number = 0;
  private backgroundListener: () => void = (): void => this.cancelCapture();
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
    (getContext(this) as common.UIAbilityContext).eventHub.on('orcaBackground', this.backgroundListener);
    let params = (router.getParams() ?? {}) as Record<string, Object>;
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

  onPageShow(): void { this.visible = true; }
  onPageHide(): void { this.visible = false; this.cancelCapture(); }
  aboutToDisappear(): void {
    this.disposed = true;
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaBackground', this.backgroundListener);
    this.cancelCapture();
  }

  private cancelCapture(): void {
    this.captureEpoch++;
    let controller = this.controller; this.controller = null;
    this.recording = false; this.starting = false; this.stopping = false; this.volume = 0;
    if (controller) { controller.cancel().catch(() => {}); }
  }

  private newDictationId(): string {
    // Upstream format: mobile-dictation-<ts>-<random> (mobile-dictation-session-state.ts).
    let random = Math.floor(Math.random() * 2176782336).toString(36);
    return `mobile-dictation-${Date.now()}-${random}`;
  }

  async doStart(): Promise<void> {
    if (this.starting || this.stopping || this.disposed || !this.visible) { return; }
    let rpc = this.rpc;
    if (!rpc) {
      this.appendLog('没有可用的 RPC 连接');
      return;
    }
    if (this.controller && this.controller.isRunning()) {
      this.appendLog('已经在录音');
      return;
    }
    this.starting = true;
    let epoch = ++this.captureEpoch;
    let controller = new DictationController(getContext(this) as common.UIAbilityContext,
      (level: number): void => {
        if (epoch === this.captureEpoch && !this.disposed) { this.volume = level; }
      });
    controller.setLogSink((line: string): void => this.appendLog(line));
    controller.onTranscript = (text: string): void => {
      if (epoch === this.captureEpoch && !this.disposed) { this.transcript = text; }
    };
    this.controller = controller;
    this.transcript = '';
    let dictationId = this.newDictationId();
    this.appendLog(`开始听写 ${dictationId}`);
    try {
      let ok = await controller.start(dictationId, rpc);
      if (this.disposed || !this.visible || epoch !== this.captureEpoch || this.controller !== controller) {
        await controller.cancel(); return;
      }
      this.recording = ok;
      if (!ok) { this.controller = null; }
    } finally { if (epoch === this.captureEpoch) { this.starting = false; } }
  }

  async doStop(): Promise<void> {
    if (this.starting) { this.cancelCapture(); return; }
    let controller = this.controller;
    if (!controller || this.stopping) { return; }
    this.stopping = true;
    let epoch = this.captureEpoch;
    try { await controller.stop(); }
    finally {
      if (epoch === this.captureEpoch && this.controller === controller) {
        this.controller = null; this.recording = false; this.volume = 0; this.stopping = false;
      }
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text(uiText('语音听写', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Text(this.channelReady ? '通道就绪' : '通道未就绪')
          .fontFamily('Geist').fontSize(12)
          .fontColor(this.channelReady ? this.themeAccent : this.themeWarning)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10 })

      Row({ space: 8 }) {
        Button(uiText(this.starting ? '取消启动' : this.recording ? '停止听写' : '开始听写', this.uiLocale))
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .backgroundColor(this.recording ? this.themeSurface : this.themeAccent)
          .enabled(this.channelReady && !this.stopping)
          .onClick(() => {
            if (this.recording || this.starting) {
              this.doStop().catch(() => {});
            } else {
              this.doStart().catch(() => {});
            }
          })
        Button(uiText('返回', this.uiLocale))
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .backgroundColor(this.themeSurface)
          .onClick(() => {
            router.back();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      Column({ space: 4 }) {
        Text(uiText('音量', this.uiLocale))
          .fontFamily('Geist').fontSize(11)
          .fontColor(this.themeSecondary)
        Progress({ value: Math.round(this.volume * 100), total: 100, type: ProgressType.Linear })
          .width('100%')
          .color(this.recording ? this.themeAccent : this.themeBorder)
        Text(`峰值 ${(this.volume * 100).toFixed(0)}%`)
          .fontFamily('Geist').fontSize(10)
          .fontColor(this.themeMuted)
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      if (this.transcript.length > 0) {
        Column({ space: 4 }) {
          Text(uiText('识别文本', this.uiLocale))
            .fontFamily('Geist').fontSize(11)
            .fontColor(this.themeSecondary)
          Text(this.transcript)
            .fontFamily('Geist').fontSize(12)
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
              .fontFamily('Geist').fontSize(10)
              .fontColor(this.themeSecondary)
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
