import { uiText } from '../settings/NativeUi';
import { appendLog as recordConnection, LOG_LEVEL_INFO } from '../diagnostics/ConnectionLogStore';
import { router } from '@kit.ArkUI';
import { HostSession, SessionPhase } from '../transport/HostSession';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { listHosts, getDeviceToken, getRelayCredential, updateHostNameAndEndpoint, HostMeta } from '../storage/HostStore';

/**
 * Host detail: supervised connection UI. Auto-reconnects (capped backoff) and probes
 * liveness while shown; manual status.get surfaces the desktop's live state.
 */
@Entry
@Component
struct HostDetail {
  @StorageProp('uiLocale') uiLocale: string = 'en';
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
  @State personalName: string = '';
  @State endpoint: string = '';
  @State editorError: string = '';
  @State saving: boolean = false;
  @State fieldsLoaded: boolean = false;
  @State showDiagnostics: boolean = false;
  private editorEpoch: number = 0;
  private initialName: string = '';
  private initialEndpoint: string = '';
  private endpointScheme: string = 'ws://';
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
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.hostId = params['hostId'];
    this.showDiagnostics = params['diagnostics'] === '1';
    this.loadEditor();
  }

  onPageShow(): void { this.active = true; if (this.showDiagnostics) { this.startSession(); } }
  onPageHide(): void { this.stopSession(); }

  aboutToDisappear(): void { this.editorEpoch++; this.stopSession(); }
  private stopSession(): void {
    this.active = false; this.epoch++;
    if (this.session) {
      this.session.stop();
      this.session = null;
    }
  }

  private async loadEditor(): Promise<void> {
    let epoch = ++this.editorEpoch;
    try {
      let hosts = await listHosts(getContext(this));
      if (epoch !== this.editorEpoch) { return; }
      let found = hosts.find((host: HostMeta): boolean => host.id === this.hostId);
      if (!found) { this.editorError = '桌面已从此手机移除'; return; }
      this.personalName = found.personalName ?? '';
      this.endpoint = found.endpoint;
      this.initialName = this.personalName; this.initialEndpoint = this.endpoint;
      this.endpointScheme = found.endpoint.startsWith('wss://') ? 'wss://' : 'ws://';
      this.fieldsLoaded = true;
    } catch (e) { if (epoch === this.editorEpoch) { this.editorError = '无法读取桌面，请重试'; } }
  }

  async saveEditor(): Promise<void> {
    if (this.saving || !this.fieldsLoaded) { return; }
    this.saving = true; this.editorError = '';
    let epoch = this.editorEpoch;
    try {
      let endpoint = this.endpoint.trim();
      if (!/^wss?:\/\//.test(endpoint)) { endpoint = `${this.endpointScheme}${endpoint}`; }
      await updateHostNameAndEndpoint(getContext(this), this.hostId, this.personalName.trim(), endpoint);
      if (epoch !== this.editorEpoch) { return; }
      router.back();
    } catch (e) {
      if (epoch === this.editorEpoch) { this.editorError = '保存失败，请检查桌面地址并重试'; }
    } finally { if (epoch === this.editorEpoch) { this.saving = false; } }
  }

  toggleDiagnostics(): void {
    this.showDiagnostics = !this.showDiagnostics;
    if (this.showDiagnostics) { this.active = true; this.startSession(); }
    else { this.stopSession(); }
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
      let context = getContext(this);
      let relayCredential = await getRelayCredential(context, meta.id);
      if (!this.active || epoch !== this.epoch) { return; }
      let session = new HostSession(meta, token, relayCredential ?? undefined, context);
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
      try {
        let result = JSON.parse(response.result) as Record<string, Object>;
        let name = result['machineName'];
        let caps = result['capabilities'];
        this.statusText = `${typeof name === 'string' ? name : '桌面'} · ${Array.isArray(caps) ? caps.length : 0} 项能力`;
      } catch (e) { this.statusText = '桌面返回了无法读取的状态'; }
      this.appendLog('status.get ok');
    } else {
      this.appendLog('status.get 失败（通道可能已断，等待自动重连）');
    }
  }

  build() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Button(uiText('返回', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
          .onClick(() => router.back())
        Text(uiText('编辑桌面', this.uiLocale))
          .fontFamily('Geist').fontSize(20)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Text(uiText(this.phase, this.uiLocale))
          .fontFamily('Geist').fontSize(12)
          .fontColor(this.phase.startsWith('已连接') ? this.themeAccent : this.themeWarning)
      }
      .width('100%')
      .padding({ left: 14, right: 14, top: 10 })

      Text(uiText('个人名称', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).width('100%')
      TextInput({ text: this.personalName, placeholder: uiText('留空使用桌面名称', this.uiLocale) })
        .fontFamily('Geist').fontSize(16).fontColor(this.themeText).height(44).enabled(this.fieldsLoaded && !this.saving)
        .onChange((value: string) => { this.personalName = value; })
      Text(uiText('桌面地址', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).width('100%')
      TextInput({ text: this.endpoint, placeholder: 'ws://192.168.1.2:9000' })
        .fontFamily('Geist').fontSize(16).fontColor(this.themeText).height(44).enabled(this.fieldsLoaded && !this.saving)
        .onChange((value: string) => { this.endpoint = value; })
      if (this.editorError.length > 0) { Text(uiText(this.editorError, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeWarning) }
      Button(uiText(this.saving ? '保存中…' : '保存', this.uiLocale)).width('100%').height(44).fontFamily('Geist').fontSize(16)
        .enabled(this.fieldsLoaded && !this.saving && this.endpoint.trim().length > 0
          && (this.personalName.trim() !== this.initialName || this.endpoint.trim() !== this.initialEndpoint))
        .onClick(() => { this.saveEditor().catch(() => {}); })
      Button(uiText('连接诊断', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary).backgroundColor(Color.Transparent)
        .onClick(() => this.toggleDiagnostics())
      if (this.showDiagnostics) {
      Row({ space: 8 }) {
        Button(uiText('打开会话', this.uiLocale))
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .backgroundColor(this.themeLink)
          .onClick(() => {
            router.pushUrl({ url: 'pages/ShellScreen', params: { hostId: this.hostId } });
          })
        Button('status.get')
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .onClick(() => {
            this.doStatusGet().catch(() => this.appendLog('状态读取失败'));
          })
        Button(uiText('返回', this.uiLocale))
          .fontFamily('Geist').fontSize(12)
          .layoutWeight(1)
          .backgroundColor(Color.Transparent).fontColor(this.themeSecondary)
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
        Text(uiText(this.statusText, this.uiLocale))
          .fontFamily('Geist').fontSize(10)
          .fontColor(this.themeLink)
          .maxLines(8)
          .width('100%')
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
    }
    .width('100%')
    .height('100%')
    .padding({ left: 16, right: 16 })
    .backgroundColor(this.themeBg)
  }
}
