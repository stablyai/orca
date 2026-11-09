import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { promptAction, router } from '@kit.ArkUI';
import { listLogs, subscribeLogs, ConnectionLogEntry } from '../diagnostics/ConnectionLogStore';
import { appVersion, connectionReport, ConnectionDiagnosis, ConnectionEvidence, ConnectionReport,
  diagnoseConnection, platformVersion, redactDiagnosticText, reportableIncident, sendConnectionReport } from '../diagnostics/ConnectionDiagnostics';
import { uiText } from '../settings/NativeUi';
import { lucideColorFilter } from '../settings/LucideColor';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { RpcSuccess, SpikeRpcClient } from '../transport/SpikeRpcClient';
import { HostMeta, listHosts } from '../storage/HostStore';

const PHASE_LABELS = new Map<string, string>([
  ['connecting', '正在连接'], ['reconnecting', '正在重连'], ['connected', '已连接'],
  ['disconnected', '已断开'], ['auth-failed', '认证失败']
]);

@Entry
@Component
struct ConnectionLog {
  @StorageProp('uiLocale') locale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeBg') backgroundTint: string = '#0a0a0a';
  @StorageProp('themeSurface') surface: string = '#171717';
  @StorageProp('themeBorder') borderTint: string = '#2c2c2c';
  @StorageProp('themeText') ink: string = '#fafafa';
  @StorageProp('themeSecondary') secondary: string = '#acacac';
  @StorageProp('themeMuted') muted: string = '#898989';
  @State hosts: HostMeta[] = [];
  @State selected: HostMeta | null = null;
  @State entries: ConnectionLogEntry[] = [];
  @State phase: string = 'disconnected';
  @State attempts: number = 0;
  @State loading: boolean = true;
  @State failed: boolean = false;
  @State diagnosis: ConnectionDiagnosis | null = null;
  @State copied: boolean = false;
  @State submission: string = '';
  private epoch: number = 0;
  private shown: boolean = false;
  private requestedId: string = '';
  private version: string | null = null;
  private versionClient: SpikeRpcClient | null = null;
  private desktop: DesktopConnectionLease | null = null;
  private unsubscribeLogs: (() => void) | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private copiedTimer: number = -1;
  private submissions: Map<string, string> = new Map();
  private logScroller: Scroller = new Scroller();

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.requestedId = params['hostId'] ?? '';
  }
  onPageShow(): void {
    this.shown = true;
    this.loadHosts().catch(() => {});
  }
  onPageHide(): void { this.shown = false; this.detach(); }
  aboutToDisappear(): void { this.shown = false; this.detach(); }

  private t(label: string): string { return uiText(label, this.locale); }
  private raised(): string { return this.scheme === 'light' ? '#f5f5f5' : '#262626'; }

  private async loadHosts(): Promise<void> {
    let epoch = ++this.epoch;
    this.loading = true; this.failed = false;
    try {
      let hosts = await listHosts(getContext(this));
      if (!this.shown || epoch !== this.epoch) { return; }
      this.hosts = hosts;
      let id = this.selected?.id ?? this.requestedId;
      let host = hosts.find((entry: HostMeta): boolean => entry.id === id) ?? hosts[0] ?? null;
      this.selectHost(host);
    } catch (e) {
      if (this.shown && epoch === this.epoch) { this.loading = false; this.failed = true; }
    }
  }

  private detach(): void {
    this.epoch++;
    this.unsubscribeLogs?.(); this.unsubscribeLogs = null;
    this.unsubscribeSession?.(); this.unsubscribeSession = null;
    this.desktop?.release(true); this.desktop = null;
    this.versionClient = null; this.version = null;
    if (this.copiedTimer >= 0) { clearTimeout(this.copiedTimer); this.copiedTimer = -1; }
  }

  private selectHost(host: HostMeta | null): void {
    this.detach();
    let epoch = this.epoch;
    this.selected = host; this.entries = []; this.diagnosis = null; this.copied = false; this.submission = '';
    this.phase = host ? 'connecting' : 'disconnected'; this.attempts = 0; this.loading = false;
    this.unsubscribeLogs = subscribeLogs((): void => { this.refreshLogs(epoch).catch(() => {}); });
    this.refreshLogs(epoch).catch(() => {});
    if (!host) { return; }
    let context = getContext(this) as common.UIAbilityContext;
    let desktop = retainDesktopConnection(context, host.id);
    this.desktop = desktop;
    this.unsubscribeSession = desktop.connection.observe((phase: SessionPhase): void => {
      if (this.shown && epoch === this.epoch) { this.observe(phase, epoch); }
    });
    desktop.connection.connect(true);
  }

  private observe(phase: SessionPhase, epoch: number): void {
    this.phase = phase === 'idle' || phase === 'stopped' ? 'disconnected' : phase;
    this.attempts = this.desktop?.connection.getReconnectAttempt() ?? 0;
    this.refreshDiagnosis();
    let client = this.phase === 'connected' ? this.desktop?.connection.getClient() ?? null : null;
    if (client === this.versionClient) { return; }
    this.versionClient = client; this.version = null;
    client?.request('status.get', null, 5000).then((reply): void => {
      if (epoch !== this.epoch || this.versionClient !== client || !(reply instanceof RpcSuccess)) { return; }
      let payload = JSON.parse(reply.result) as Record<string, Object>;
      this.version = typeof payload?.['appVersion'] === 'string' ? payload['appVersion'] as string : null;
    }).catch(() => {});
  }

  private evidence(): ConnectionEvidence {
    return { endpoint: this.selected?.endpoint ?? '', state: this.phase,
      activePath: this.desktop?.connection.getConnectedAt() != null ? this.desktop?.connection.getActivePath() : undefined,
      pendingPath: this.desktop?.connection.getPendingPath(), entries: this.entries };
  }

  private incidentKey(): string {
    let id = this.selected ? reportableIncident(this.evidence()) : null;
    return id ? `${this.selected?.id}:${id}` : '';
  }

  private refreshDiagnosis(): void {
    this.diagnosis = this.selected ? diagnoseConnection(this.evidence()) : null;
    this.submission = this.submissions.get(this.incidentKey()) ?? '';
  }

  private async refreshLogs(epoch: number): Promise<void> {
    if (!this.shown || epoch !== this.epoch) { return; }
    let entries = await listLogs(getContext(this), this.selected?.id ?? '');
    if (!this.shown || epoch !== this.epoch) { return; }
    this.entries = entries;
    this.refreshDiagnosis();
  }

  private report(version: string, platform: string): string {
    let host = this.selected;
    if (!host) { return connectionReport(null, this.entries); }
    let evidence = this.evidence();
    let report: ConnectionReport = {
      endpoint: evidence.endpoint, state: evidence.state, activePath: evidence.activePath, pendingPath: evidence.pendingPath,
      entries: evidence.entries, hostName: redactDiagnosticText(host.name), reconnectAttempts: this.attempts,
      lastConnectedAt: this.desktop?.connection.getConnectedAt() ?? null, desktopAppVersion: this.version,
      appVersion: version, platform: platform, bridgeProtocolVersion: 1
    };
    return connectionReport(report, this.entries);
  }

  private async copyReport(): Promise<void> {
    let epoch = this.epoch;
    try {
      await this.refreshLogs(epoch);
      if (epoch !== this.epoch) { return; }
      let data = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.report(appVersion(), platformVersion()));
      await pasteboard.getSystemPasteboard().setData(data);
      if (epoch !== this.epoch) { return; }
      this.copied = true;
      if (this.copiedTimer >= 0) { clearTimeout(this.copiedTimer); }
      this.copiedTimer = setTimeout((): void => { this.copied = false; this.copiedTimer = -1; }, 2000);
    } catch (e) {
      if (epoch === this.epoch) { promptAction.showToast({ message: this.t('无法复制报告') }); }
    }
  }

  private async sendReport(): Promise<void> {
    let key = this.incidentKey();
    let epoch = this.epoch;
    if (!key || this.submissions.get(key) === 'sending') { return; }
    this.submissions.set(key, 'sending'); this.submission = 'sending';
    try {
      await this.refreshLogs(epoch);
      if (epoch !== this.epoch || key !== this.incidentKey()) { this.submissions.delete(key); return; }
      let version = appVersion(); let platform = platformVersion();
      let ok = await sendConnectionReport(this.report(version, platform), version, platform);
      this.submissions.set(key, ok ? 'sent' : 'failed');
    } catch (e) { this.submissions.set(key, 'failed'); }
    finally { if (this.shown) { this.refreshDiagnosis(); } }
  }

  private age(ts: number): string {
    let ms = ts - (this.entries[0]?.ts ?? ts);
    return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
  }
  private color(level: string): string {
    if (level === 'error') { return this.scheme === 'light' ? '#b91c1c' : '#ff6568'; }
    if (level === 'warn') { return this.scheme === 'light' ? '#ca8a04' : '#eab308'; }
    if (level === 'success') { return this.scheme === 'light' ? '#147638' : '#86efac'; }
    return this.secondary;
  }

  @Builder
  private navigation() {
    Stack({ alignContent: Alignment.Center }) {
      Text(this.t('网络诊断')).fontFamily('Geist').fontSize(17).fontWeight(FontWeight.Medium).fontColor(this.ink)
      Row() {
        Button({ type: ButtonType.Normal }) {
          Image($r('app.media.lucide_chevron_left')).supportSvg2(true).width(22).height(22)
            .colorFilter(lucideColorFilter(this.secondary))
        }.width(40).height(40).borderRadius(12).backgroundColor(Color.Transparent)
          .accessibilityText(this.t('返回')).onClick((): void => { router.back(); })
      }.width('100%')
    }.width('100%').height(48).padding({ left: 12, right: 12 })
  }

  @Builder
  private status() {
    Row({ space: 8 }) {
      Text(this.selected ? (this.attempts > 0
        ? this.t('{{state}} · 第 {{attempts}} 次尝试').replace('{{state}}', this.t(PHASE_LABELS.get(this.phase) ?? this.phase))
          .replace('{{attempts}}', String(this.attempts))
        : this.t(PHASE_LABELS.get(this.phase) ?? this.phase)) : this.t('没有配对的桌面。'))
        .fontFamily('Geist').fontSize(12).fontColor(this.secondary).layoutWeight(1)
      Button({ type: ButtonType.Normal }) {
        Row({ space: 6 }) {
          Image(this.copied ? $r('app.media.lucide_check') : $r('app.media.lucide_copy')).supportSvg2(true)
            .width(14).height(14).colorFilter(lucideColorFilter(this.copied ? this.color('success') : this.secondary))
          Text(this.t(this.copied ? '已复制' : '复制报告')).fontFamily('Geist').fontSize(12)
            .fontWeight(FontWeight.Medium).fontColor(this.ink)
        }
      }.height(36).borderRadius(12).backgroundColor(this.raised()).padding({ left: 12, right: 12 })
        .accessibilityText(this.t(this.copied ? '已复制' : '复制报告'))
        .onClick((): void => { this.copyReport().catch(() => {}); })
    }.width('100%')
  }

  @Builder
  private diagnosisCard() {
    Column({ space: 4 }) {
      Text(this.t('诊断结果')).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Medium).fontColor(this.ink)
      Text(this.diagnosis?.likelyCause ?? '').fontFamily('Geist').fontSize(12).lineHeight(18).fontColor(this.ink)
      Text(this.diagnosis?.nextStep ?? '').fontFamily('Geist').fontSize(12).lineHeight(18).fontColor(this.secondary)
      if (this.diagnosis?.reportability === 'orca-relay') {
        Text(this.t('报告包括桌面名称、地址、版本、连接状态和事件，已移除凭证和终端内容。'))
          .fontFamily('Geist').fontSize(11).lineHeight(15).fontColor(this.muted).margin({ top: 4 })
        Button(this.t(this.submission === 'sending' ? '正在发送…' : this.submission === 'sent' ? '诊断已发送' :
          this.submission === 'failed' ? '重试发送' : '向 Orca 发送诊断'), { type: ButtonType.Normal })
          .fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Medium).fontColor(this.ink)
          .enabled(this.submission !== 'sending').backgroundColor(this.raised()).borderRadius(12)
          .padding({ left: 12, right: 12 }).height(36).margin({ top: 8 })
          .onClick((): void => { this.sendReport().catch(() => {}); })
      }
    }.alignItems(HorizontalAlign.Start).width('100%').padding(12).backgroundColor(this.surface)
      .border({ width: 0.5, color: this.borderTint, radius: 16 })
  }

  @Builder
  private history() {
    if (this.entries.length > 0) {
      if (this.selected) {
        Text(this.selected.name).fontFamily('monospace').fontSize(11).letterSpacing(1).fontColor(this.muted)
      }
      List({ space: 6, scroller: this.logScroller }) {
        ForEach(this.entries, (entry: ConnectionLogEntry) => {
          ListItem() {
            Row({ space: 8 }) {
              Text(this.age(entry.ts)).fontFamily('monospace').fontSize(11).fontColor(this.muted).width(55)
              Text(entry.level === 'error' ? '×' : entry.level === 'success' ? '✓' : entry.level === 'warn' ? '!' : '·')
                .fontFamily('monospace').fontSize(11).fontColor(this.color(entry.level))
              Column({ space: 2 }) {
                Text(this.t(entry.message)).fontFamily('monospace').fontSize(11).fontColor(this.color(entry.level))
                if (entry.detail) { Text(entry.detail).fontFamily('monospace').fontSize(11).fontColor(this.muted).maxLines(2) }
              }.layoutWeight(1).alignItems(HorizontalAlign.Start)
            }.width('100%').alignItems(VerticalAlign.Top)
          }
        }, (entry: ConnectionLogEntry): string => entry.id)
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off)
        .onAppear((): void => { this.logScroller.scrollEdge(Edge.Bottom); })
    } else {
      Text(this.t(this.selected ? '暂无连接事件。应用连接这台桌面时会记录事件。' : '没有配对的桌面。'))
        .fontFamily('Geist').fontSize(12).lineHeight(18).fontColor(this.muted)
    }
  }

  build() {
    Column() {
      this.navigation()
      Column({ space: 12 }) {
        if (this.loading) {
          LoadingProgress().width(28).height(28).color(this.secondary)
        } else if (this.failed) {
          Text(this.t('无法读取已配对桌面，请重试。')).fontFamily('Geist').fontSize(14).fontColor(this.secondary)
          Button(this.t('重试')).onClick((): void => { this.loadHosts().catch(() => {}); })
        } else {
          if (this.hosts.length > 1) {
            Flex({ wrap: FlexWrap.Wrap }) {
              ForEach(this.hosts, (host: HostMeta) => {
                Button(host.name).fontFamily('Geist').fontSize(12).fontColor(this.selected?.id === host.id ? this.ink : this.secondary)
                  .backgroundColor(this.selected?.id === host.id ? this.surface : this.raised())
                  .border({ width: 0.5, color: this.selected?.id === host.id ? this.borderTint : Color.Transparent, radius: 999 })
                  .constraintSize({ maxWidth: 160 }).height(32).margin({ right: 8, bottom: 4 })
                  .onClick((): void => { if (host.id !== this.selected?.id) { this.selectHost(host); } })
              }, (host: HostMeta): string => host.id)
            }.width('100%')
          }
          if (this.selected || this.entries.length > 0) { this.status() }
          if (this.diagnosis) { this.diagnosisCard() }
          this.history()
        }
      }.width('100%').layoutWeight(1).alignItems(HorizontalAlign.Start).padding({ left: 16, right: 16, top: 12, bottom: 20 })
    }.width('100%').height('100%').backgroundColor(this.backgroundTint)
  }
}
