import { appendLog as recordConnection, LOG_LEVEL_INFO } from '../diagnostics/ConnectionLogStore';
import { router } from '@kit.ArkUI';
import { HostSession, SessionPhase } from '../transport/HostSession';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { listHosts, getDeviceToken, HostMeta } from '../storage/HostStore';

/**
 * Host detail: supervised connection UI. Auto-reconnects (capped backoff) and probes
 * liveness while shown; manual status.get surfaces the desktop's live state.
 */
@Entry
@Component
struct HostDetail {
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  @State phase: string = 'idle';
  @State logs: string[] = [];
  @State statusText: string = '';
  private session: HostSession | null = null;
  private hostId: string = '';
  private active: boolean = false;
  private epoch: number = 0;

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
    let params = router.getParams() as Record<string, string>;
    this.hostId = params['hostId'];
  }

  onPageShow(): void { this.active = true; this.startSession(); }
  onPageHide(): void { this.stopSession(); }

  aboutToDisappear(): void { this.stopSession(); }
  private stopSession(): void {
    this.active = false; this.epoch++;
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
  }

  async startSession(): Promise<void> {
    let epoch = ++this.epoch;
    if (this.session) { this.session.stop(); this.session = null; }
    try {
      let hosts: HostMeta[] = await listHosts(getContext(this));
      let meta: HostMeta | null = null;
      for (let i = 0; i < hosts.length; i++) {
        if (hosts[i].id === this.hostId) {
          meta = hosts[i];
          break;
        }
      }
      if (meta === null) {
        this.appendLog('主机不存在');
        return;
      }
      let token = await getDeviceToken(getContext(this), meta.id);
      if (token === null) {
        this.appendLog('凭证缺失（Asset Store）— 请重新配对');
        return;
      }
      if (!this.active || epoch !== this.epoch) { return; }
      this.appendLog(`正在连接 ${meta.name}`);
      let session = new HostSession(meta, token);
      this.session = session;
      session.setLogSink((line: string): void => this.appendLog(line));
      session.addListener((phase: SessionPhase, detail: string): void => {

        let label = phase === 'connected' ? '已连接' : phase === 'reconnecting' ? '正在重连' : phase === 'connecting' ? '正在连接' : '已断开';
        recordConnection(getContext(this), LOG_LEVEL_INFO, label, '').catch(() => {});
        this.phase = detail.length > 0 ? `${label} · ${detail}` : label;
      });
      session.start();
    } catch (e) {
      this.appendLog(`启动失败: ${(e as Error).message}`);
    }
  }

  async doStatusGet(): Promise<void> {
    let session = this.session;
    if (!session) {
      return;
    }
    let client: SpikeRpcClient | null = session.getClient();
    if (!client) {
      this.appendLog('通道未就绪');
      return;
    }
    let response: RpcResponse = await client.request('status.get', null);
    if (response instanceof RpcSuccess) {
      let text = response.result;
      this.statusText = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      this.appendLog('status.get ok');
    } else {
      this.appendLog('status.get 失败（通道可能已断，等待自动重连）');
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('桌面连接')
          .fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Text(this.phase)
          .fontSize(12)
          .fontColor(this.phase.startsWith('已连接') ? this.themeAccent : this.themeWarning)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10 })

      Row({ space: 8 }) {
        Button('打开会话')
          .fontSize(12)
          .layoutWeight(1)
          .backgroundColor('#2a6a5a')
          .onClick(() => {
            router.pushUrl({ url: 'pages/ShellScreen', params: { hostId: this.hostId } });
          })
        Button('status.get')
          .fontSize(12)
          .layoutWeight(1)
          .onClick(() => {
            this.doStatusGet();
          })
        Button('断开')
          .fontSize(12)
          .layoutWeight(1)
          .backgroundColor('#5a2a2a')
          .onClick(() => {
            if (this.session) {
              this.session.stop();
            }
            router.back();
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12 })

      if (this.statusText.length > 0) {
        Text(this.statusText)
          .fontSize(10)
          .fontColor(this.themeLink)
          .maxLines(8)
          .width('100%')
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
