import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { directPath, endpointLabel, platformVersion, TroubleshootIssue, troubleshootIssues } from '../diagnostics/ConnectionDiagnostics';
import { ConnectionLogEntry, listLogs } from '../diagnostics/ConnectionLogStore';
import { ProbeStatus, TroubleshootProbes } from '../diagnostics/TroubleshootProbes';
import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import { SettingsNavBar } from '../settings/SettingsNavBar';
import { HostMeta, listHosts } from '../storage/HostStore';

interface CheckResult { id: string; label: string; status: ProbeStatus; detail: string; }
interface UpdateFailure { id: string; name: string; ts: number; }
const RUN = 'diagnostics.troubleshootView.';
const CHECK = 'diagnostics.useTroubleshootDiagnostics.';

@Entry
@Component
struct Troubleshoot {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') themeScheme: string = 'dark';
  @StorageProp('themeBg') themeBg: string = '#0a0a0a';
  @StorageProp('themeRaised') themeRaised: string = '#262626';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = 'rgba(255, 255, 255, 0.07)';
  @StorageProp('themeText') themeText: string = '#fafafa';
  @StorageProp('themeMuted') themeMuted: string = '#898989';
  @StorageProp('themeSecondary') themeSecondary: string = '#acacac';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  @State endpoints: string[] = [];
  @State checks: CheckResult[] = [];
  @State failures: UpdateFailure[] = [];
  @State phase: string = 'idle';
  @State expanded: string = '';
  private pageRevision: number = 0;
  private revision: number = 0;
  private probes: TroubleshootProbes = new TroubleshootProbes();

  onPageShow(): void {
    let pageRevision = ++this.pageRevision;
    let revision = this.revision;
    let context = getContext(this) as common.Context;
    listHosts(context).then(async (hosts: HostMeta[]): Promise<void> => {
      if (pageRevision !== this.pageRevision) { return; }
      if (revision === this.revision) { this.endpoints = hosts.map((host: HostMeta): string => host.endpoint); }
      let failures = await Promise.all(hosts.map(async (host: HostMeta): Promise<UpdateFailure | null> => {
        let logs = await listLogs(context, host.id);
        let failure = logs.slice().reverse().find((entry: ConnectionLogEntry): boolean => entry.code === 'web-shell-update-failed');
        return failure ? { id: host.id, name: host.name, ts: failure.ts } : null;
      }));
      if (pageRevision === this.pageRevision) {
        let latest: UpdateFailure[] = [];
        failures.forEach((failure: UpdateFailure | null): void => { if (failure) { latest.push(failure); } });
        this.failures = latest;
      }
    }).catch(() => {});
  }

  onPageHide(): void {
    this.pageRevision++; this.revision++; this.probes.cancel();
    if (this.phase === 'running') { this.phase = 'idle'; this.checks = []; }
  }

  aboutToDisappear(): void { this.onPageHide(); }

  private t(key: string): string { return uiText(key, this.uiLocale); }

  private add(id: string, label: string, status: ProbeStatus, detail: string): void {
    this.checks = this.checks.concat([{ id: id, label: label, status: status, detail: detail }]);
  }

  private async run(): Promise<void> {
    if (this.phase === 'running') { return; }
    this.phase = 'running'; this.checks = [];
    let revision = ++this.revision;
    let hosts: HostMeta[] = [];
    try {
      hosts = await listHosts(getContext(this));
      if (revision !== this.revision) { return; }
      this.endpoints = hosts.map((host: HostMeta): string => host.endpoint);
      this.add('hosts', this.t(CHECK + 'pairedHosts'), hosts.length > 0 ? 'pass' : 'fail',
        hosts.length > 0 ? this.t(CHECK + 'pairedCount').replace('{{count}}', String(hosts.length)) : this.t(CHECK + 'noPairedHosts'));
    } catch (e) {
      if (revision !== this.revision) { return; }
      this.add('hosts', this.t(CHECK + 'pairedHosts'), 'warn', this.t(CHECK + 'hostDataFailed'));
    }

    let internet = await this.probes.internet().catch((): ProbeStatus => 'fail');
    if (revision !== this.revision) { return; }
    this.add('internet', this.t(CHECK + 'internet'), internet, this.t(CHECK +
      (internet === 'pass' ? 'connected' : internet === 'warn' ? 'unexpectedResponse' : 'noConnection')));

    for (let host of hosts) {
      if (!host.endpoint && host.relay) {
        this.add(host.id, host.name, 'warn', this.t('此桌面仅使用 Relay。请在网络诊断中查看其连接状态。'));
        continue;
      }
      let reachable = await this.probes.desktop(host.endpoint).catch((): boolean => false);
      if (revision !== this.revision) { return; }
      let detail = reachable ? CHECK + 'reachable' : directPath(host.endpoint) === 'tailscale' ?
        '无法连接 {{endpoint}}，请检查 Tailscale。' : '无法连接 {{endpoint}}。';
      this.add(host.id, host.name, reachable ? 'pass' : 'fail', this.t(detail).replace('{{endpoint}}', endpointLabel(host.endpoint)));
    }

    this.add('platform', this.t(CHECK + 'platform'), 'pass', platformVersion());
    this.phase = 'done';
  }

  private issueIcon(kind: string): Resource {
    switch (kind) {
      case 'notifications': return $r('app.media.lucide_bell');
      case 'wifi': return $r('app.media.lucide_wifi_off');
      case 'desktop': return $r('app.media.lucide_monitor');
      case 'timeout': return $r('app.media.lucide_clock');
      case 'tailscale': return $r('app.media.lucide_globe');
      default: return $r('app.media.lucide_shield');
    }
  }

  @Builder
  private separator() {
    Divider().strokeWidth(0.5).color(this.themeBorder).margin({ left: 40 })
  }

  @Builder
  private button(label: string, id: string, icon: Resource, busy: boolean, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        if (busy) {
          LoadingProgress().width(16).height(16).color(this.themeText)
        } else {
          Image(icon).supportSvg2(true).width(16).height(16).colorFilter(lucideColorFilter(this.themeText))
        }
        Text(this.t(label)).fontFamily('Geist').fontSize(15).fontWeight(FontWeight.Medium).fontColor(this.themeText)
      }.justifyContent(FlexAlign.Center).width('100%').padding({ top: 12, bottom: 12, left: 12, right: 12 })
    }.width('100%').constraintSize({ minHeight: 46 }).borderRadius(10).backgroundColor(this.themeRaised)
      .enabled(!busy).id(id).accessibilityText(this.t(label)).onClick(action)
  }

  @Builder
  private heading(label: string) {
    Text(this.t(label)).fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.themeSecondary)
      .width('100%').padding({ left: 16, bottom: 8 })
  }

  @Builder
  private checkRow(check: CheckResult) {
    Row({ space: 10 }) {
      Image(check.status === 'pass' ? $r('app.media.lucide_circle_check') : check.status === 'fail' ?
        $r('app.media.lucide_circle_x') : $r('app.media.lucide_triangle_alert'))
        .supportSvg2(true).width(14).height(14).colorFilter(lucideColorFilter(check.status === 'pass' ?
          (this.themeScheme === 'light' ? '#147638' : '#86efac') : check.status === 'fail' ? this.themeStatusRed : this.themeMuted))
      Column({ space: 3 }) {
        Text(check.label).fontFamily('Geist').fontSize(15).fontColor(this.themeText)
        Text(check.detail).fontFamily('Geist').fontSize(13).lineHeight(18)
          .fontColor(check.status === 'fail' ? this.themeStatusRed : this.themeMuted)
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
    }.width('100%').padding({ left: 16, right: 16, top: 10, bottom: 10 })
  }

  @Builder
  private issueRow(issue: TroubleshootIssue) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 10 }) {
        Image(this.issueIcon(issue.kind)).supportSvg2(true).width(16).height(16)
          .colorFilter(lucideColorFilter(this.themeSecondary))
        Text(issue.title).fontFamily('Geist').fontSize(15).fontColor(this.themeText).layoutWeight(1)
        Image(this.expanded === issue.id ? $r('app.media.lucide_chevron_up') : $r('app.media.lucide_chevron_down'))
          .supportSvg2(true).width(16).height(16).colorFilter(lucideColorFilter(this.themeMuted))
      }.width('100%').padding({ left: 16, right: 16, top: 12, bottom: 12 })
    }.width('100%').constraintSize({ minHeight: 48 }).backgroundColor(Color.Transparent).id(`diagnostic-issue-${issue.id}`)
      .accessibilityText(issue.title).onClick((): void => { this.expanded = this.expanded === issue.id ? '' : issue.id; })
    if (this.expanded === issue.id) {
      Column({ space: 4 }) {
        ForEach(issue.steps, (step: string): void => {
          Row({ space: 8 }) {
            Text('•').fontFamily('Geist').fontSize(13).fontColor(this.themeMuted)
            Text(step).fontFamily('Geist').fontSize(13).lineHeight(18).fontColor(this.themeMuted).layoutWeight(1)
          }.width('100%').alignItems(VerticalAlign.Top)
        }, (step: string): string => step)
      }.width('100%').padding({ left: 40, right: 16, bottom: 12 })
    }
  }

  build() {
    Column() {
      SettingsNavBar({ title: this.t(RUN + 'title') })
      Scroll() {
        Column({ space: 16 }) {
          if (this.phase === 'running') {
            this.button(RUN + 'running', 'diagnostics-run', $r('app.media.lucide_activity'), true, (): void => {})
          } else if (this.phase === 'done') {
            this.button(RUN + 'runAgain', 'diagnostics-run', $r('app.media.lucide_activity'), false, (): void => { this.run().catch(() => {}); })
          } else {
            this.button(RUN + 'runDiagnostics', 'diagnostics-run', $r('app.media.lucide_activity'), false, (): void => { this.run().catch(() => {}); })
          }
          this.button(RUN + 'viewNetworkDiagnostics', 'diagnostics-log', $r('app.media.lucide_scroll_text'), false,
            (): void => { router.pushUrl({ url: 'pages/ConnectionLog' }).catch(() => {}); })
          if (this.failures.length > 0) {
            Column() {
              this.heading('diagnostics.mobileWebShellUpdateFailureRow.title')
              Column({ space: 8 }) {
                ForEach(this.failures, (failure: UpdateFailure): void => {
                  Text(this.t('{{hostName}} 的工作区更新失败，已保留上次可用版本。').replace('{{hostName}}', failure.name))
                    .fontFamily('Geist').fontSize(13).lineHeight(18).fontColor(this.themeMuted).width('100%')
                }, (failure: UpdateFailure): string => `${failure.id}:${failure.ts}`)
              }.width('100%').padding(16).borderRadius(16).backgroundColor(this.themeSurface)
            }.width('100%')
          }
          if (this.checks.length > 0) {
            Column() {
              ForEach(this.checks, (check: CheckResult, index: number): void => {
                if (index > 0) { this.separator() }
                this.checkRow(check)
              }, (check: CheckResult): string => check.id)
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
          }
          Column() {
            this.heading(RUN + 'commonIssues')
            Column() {
              ForEach(troubleshootIssues(this.endpoints, this.uiLocale), (issue: TroubleshootIssue, index: number): void => {
                if (index > 0) { this.separator() }
                this.issueRow(issue)
              }, (issue: TroubleshootIssue): string => `${issue.id}:${issue.title}`)
            }.width('100%').backgroundColor(this.themeSurface).borderRadius(16).clip(true)
          }.width('100%')
        }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 24 })
      }.width('100%').layoutWeight(1).scrollBar(BarState.Off).align(Alignment.Top)
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }
}
