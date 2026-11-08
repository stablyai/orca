import { router, promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { parseLaunchRoute } from '../navigation/LaunchRoute';
import { getNumber, KEY_HOME_FONT_SCALE } from '../settings/SettingsStore';
import { deletePageStorage } from '../storage/PageStorageStore';
import { listHosts, deleteHost, getDeviceToken, HostMeta } from '../storage/HostStore';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';

/**
 * Home：对齐上游 MobileHomeScreen（src/home/MobileHomeScreen.tsx）的外壳结构——
 * 底部 4 个 Tab（动态 feed / 使用情况 usage / 自动化 automations / 设置 settings），
 * feed 页 = MobileHomeJumpBackIn（智能体）+ DesktopRow（台式机）+ 未配对空态 +
 * 浮动「New workspace」FAB。主题取上游 mobile-theme.ts 的暗色/亮色 palette。
 */

// upstream src/theme/mobile-theme.ts: darkColors / lightColors（外壳用到的子集）
interface HomePalette {
  bgBase: string;
  bgPanel: string;
  bgRaised: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentBlue: string;
  onAccent: string;
  statusGreen: string;
  statusAmber: string;
  statusRed: string;
}

const PALETTE_DARK: HomePalette = {
  bgBase: '#0a0a0a',
  bgPanel: '#171717',
  bgRaised: '#262626',
  borderSubtle: '#2c2c2c', // rgba(255,255,255,0.07) over #0a0a0a/#171717
  textPrimary: '#fafafa',
  textSecondary: '#acacac',
  textMuted: '#898989',
  accentBlue: '#3276f2',
  onAccent: '#ffffff',
  statusGreen: '#86efac',
  statusAmber: '#eab308',
  statusRed: '#ff6568'
};

const PALETTE_LIGHT: HomePalette = {
  bgBase: '#ffffff',
  bgPanel: '#fafafa',
  bgRaised: '#f5f5f5',
  borderSubtle: '#e5e5e5',
  textPrimary: '#0a0a0a',
  textSecondary: '#696969',
  textMuted: '#696969',
  accentBlue: '#225be3',
  onAccent: '#ffffff',
  statusGreen: '#147638',
  statusAmber: '#ca8a04',
  statusRed: '#e40014'
};

// Agent 状态点配色：上游 AgentSpinner.agentStatusColors()
const DOT_WORKING = '#eab308';
const DOT_DONE = '#10b981';
const DOT_NEEDS_YOU = '#ef4444';

interface TabSpec {
  id: string;
  label: string;
  icon: Resource;
}

interface JumpRow {
  hostId: string;
  hostName: string;
  worktreeId: string;
  title: string;
  repo: string;
  state: string; // 原始 agent state（宽松解析）
}

interface WorktreeAcc {
  worktreeId: string;
  title: string;
  repo: string;
  state: string;
}

interface HostRuntime {
  client: SpikeRpcClient | null;
  online: boolean;
  connecting: boolean;
}

interface SettingsRow {
  label: string;
  icon: Resource;
  target: string;
}

const TAB_SPECS: TabSpec[] = [
  { id: 'feed', label: '动态', icon: $r('sys.symbol.list_bullet') },
  { id: 'usage', label: '使用情况', icon: $r('sys.symbol.gauge_with_dots_needle_33percent') },
  { id: 'automations', label: '自动化', icon: $r('sys.symbol.calendar_badge_clock') },
  { id: 'settings', label: '设置', icon: $r('sys.symbol.gearshape') }
];

// 上游 settings.menuItems.*（zh）+ 图标顺序（mobile-settings-menu-items.ts 的子集）
const SETTINGS_ROWS: SettingsRow[] = [
  { label: '外观', icon: $r('sys.symbol.sun_max'), target: 'pages/AppearanceSettings' },
  { label: '终端', icon: $r('sys.symbol.arrow_left_arrow_right'), target: 'pages/TerminalSettings' },
  { label: '语音', icon: $r('sys.symbol.mic'), target: 'pages/VoiceSettings' },
  { label: '通知', icon: $r('sys.symbol.bell'), target: 'pages/NotificationSettings' },
  { label: '故障排查', icon: $r('sys.symbol.wrench_and_screwdriver'), target: 'pages/Troubleshoot' },
  { label: '连接事件日志', icon: $r('sys.symbol.doc_text'), target: 'pages/ConnectionLog' },
  { label: '关于', icon: $r('sys.symbol.info_circle'), target: 'pages/About' }
];

const FAB_SIZE = 56;
const TAB_BAR_HEIGHT = 64; // paddingTop 6 + 图标 26 + 文本 + paddingBottom 8（上游 52 + inset）

@Entry
@Component
struct Home {
  @StorageProp('themeScheme') scheme: string = 'dark';
  @State activeTab: string = 'feed';
  @State hosts: HostMeta[] = [];
  @State loaded: boolean = false;
  @State fontScale: number = 1;
  @State online: Record<string, boolean> = {};
  @State connecting: boolean = false;
  @State agentRows: JumpRow[] = [];
  private runtimes: Map<string, HostRuntime> = new Map();
  private accByHost: Map<string, Map<string, WorktreeAcc>> = new Map();
  private epoch: number = 0;

  // ---------------------------------------------------------------- helpers

  pal(): HomePalette {
    return this.scheme === 'light' ? PALETTE_LIGHT : PALETTE_DARK;
  }

  aboutToAppear(): void {
    this.reload();
  }

  onPageShow(): void {
    let uri = AppStorage.get<string>('pendingLaunchUri') ?? '';
    AppStorage.setOrCreate('pendingLaunchUri', '');
    let destination = parseLaunchRoute(uri);
    if (destination) {
      let page = destination.page;
      let params = destination.params;
      setTimeout((): void => { router.pushUrl({ url: page, params: params }).catch(() => {}); }, 0);
    }
    this.reload();
    getNumber(getContext(this) as common.Context, KEY_HOME_FONT_SCALE).then((v: number): void => {
      this.fontScale = Math.max(0.8, Math.min(1.5, v));
    }).catch(() => {});
  }

  onPageHide(): void {
    this.stopProbes();
  }

  aboutToDisappear(): void {
    this.stopProbes();
  }

  reload(): void {
    listHosts(getContext(this) as common.Context).then((hosts: HostMeta[]): void => {
      this.hosts = hosts;
      this.loaded = true;
      this.startProbes();
    }).catch((_e: Error) => {
      this.hosts = [];
      this.loaded = true;
      this.stopProbes();
    });
  }

  onlineCount(): number {
    let count = 0;
    for (let i = 0; i < this.hosts.length; i++) {
      let onlineValue = this.online[this.hosts[i].id];
      if (onlineValue === true) {
        count++;
      }
    }
    return count;
  }

  firstOnlineHostId(): string {
    for (let i = 0; i < this.hosts.length; i++) {
      if (this.online[this.hosts[i].id] === true) {
        return this.hosts[i].id;
      }
    }
    return this.hosts.length > 0 ? this.hosts[0].id : '';
  }

  needsYouCount(): number {
    let count = 0;
    for (let i = 0; i < this.agentRows.length; i++) {
      if (isNeedsYou(this.agentRows[i].state)) {
        count++;
      }
    }
    return count;
  }

  // ------------------------------------------------- live probes + tab data

  private syncConnState(): void {
    let next: Record<string, boolean> = {};
    let anyConnecting = false;
    this.runtimes.forEach((rt: HostRuntime, hostId: string): void => {
      next[hostId] = rt.online;
      if (rt.connecting) {
        anyConnecting = true;
      }
    });
    this.online = next;
    this.connecting = anyConnecting;
    this.rebuildRows();
  }

  private stopProbes(): void {
    this.epoch++;
    this.runtimes.forEach((rt: HostRuntime): void => {
      if (rt.client) {
        rt.client.close();
      }
    });
    this.runtimes.clear();
    this.accByHost.clear();
    this.agentRows = [];
    this.connecting = false;
  }

  private startProbes(): void {
    this.stopProbes();
    let myEpoch = this.epoch;
    for (let i = 0; i < this.hosts.length; i++) {
      this.probeHost(this.hosts[i], myEpoch);
    }
  }

  private probeHost(host: HostMeta, epoch: number): void {
    getDeviceToken(getContext(this) as common.Context, host.id).then((token: string | null): void => {
      if (epoch !== this.epoch) {
        return;
      }
      if (token === null || token.length === 0) {
        let offline: HostRuntime = { client: null, online: false, connecting: false };
        this.runtimes.set(host.id, offline);
        this.syncConnState();
        return;
      }
      let client = new SpikeRpcClient(8000, 6000);
      let rt: HostRuntime = { client: client, online: false, connecting: true };
      this.runtimes.set(host.id, rt);
      this.syncConnState();
      client.onSocketClosed((): void => {
        rt.online = false;
        rt.connecting = false;
        this.accByHost.delete(host.id);
        this.syncConnState();
      });
      client.connect(host.endpoint, token, host.publicKeyB64, 'v2').then((): void => {
        if (epoch !== this.epoch) {
          client.close();
          return;
        }
        rt.online = true;
        rt.connecting = false;
        this.syncConnState();
        this.subscribeTabs(client, host.id);
        client.request('status.get', null, 6000).then((_r: RpcResponse): void => {
          // 活性确认：失败时靠 socket 关闭回调兜底，这里无需额外处理
        }).catch(() => {});
      }).catch((_e: Error): void => {
        rt.online = false;
        rt.connecting = false;
        this.syncConnState();
      });
    }).catch((_e: Error): void => {
    });
  }

  /** 上游 session.tabs.subscribeAll：聚合该主机的活跃 worktree/agent 状态。 */
  private subscribeTabs(client: SpikeRpcClient, hostId: string): void {
    try {
      let subId = `home-tabs-${hostId}`;
      let obj: Record<string, Object> = {
        'id': subId,
        'deviceToken': client.deviceToken,
        'method': 'session.tabs.subscribeAll'
      };
      client.subscribeWithId(subId, JSON.stringify(obj), (frame: string): void => {
        this.onTabsFrame(hostId, frame);
      });
    } catch (e) {
      // 宽松处理：订阅失败只影响 JumpBackIn，不影响其余 UI
    }
  }

  /** 事件帧 {id, streaming, result:{type, worktree|snapshots, tabs}} 的宽松解析（参照 AgentWatch）。 */
  private onTabsFrame(hostId: string, frameJson: string): void {
    try {
      let parsed: Object | null = JSON.parse(frameJson) as Object | null;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      let rec = parsed as Record<string, Object>;
      let eventSource: Object = rec;
      let streamingValue: Object = rec['streaming'];
      if (streamingValue === true) {
        let resultValue: Object = rec['result'];
        if (resultValue === null || resultValue === undefined || typeof resultValue !== 'object'
          || Array.isArray(resultValue)) {
          return;
        }
        eventSource = resultValue;
      }
      let event = eventSource as Record<string, Object>;
      let typeValue: Object = event['type'];
      if (typeof typeValue !== 'string') {
        return;
      }
      let hostAcc = this.accByHost.get(hostId);
      if (hostAcc === undefined) {
        hostAcc = new Map<string, WorktreeAcc>();
        this.accByHost.set(hostId, hostAcc);
      }
      if (typeValue === 'snapshots') {
        let snapshotsValue: Object = event['snapshots'];
        if (snapshotsValue !== null && snapshotsValue !== undefined && Array.isArray(snapshotsValue)) {
          let snapshots = snapshotsValue as Array<Object>;
          for (let i = 0; i < snapshots.length; i++) {
            this.absorbSnapshot(hostAcc, snapshots[i]);
          }
          this.rebuildRows();
        }
        return;
      }
      if (typeValue === 'snapshot' || typeValue === 'updated') {
        this.absorbSnapshot(hostAcc, eventSource);
        this.rebuildRows();
        return;
      }
    } catch (e) {
      // 宽松解析：未知帧直接忽略
    }
  }

  /** 单个 per-worktree 帧：{worktree, tabs:[...]}（宽松）。 */
  private absorbSnapshot(hostAcc: Map<string, WorktreeAcc>, snapshotValue: Object): void {
    if (snapshotValue === null || snapshotValue === undefined || typeof snapshotValue !== 'object'
      || Array.isArray(snapshotValue)) {
      return;
    }
    let snapshot = snapshotValue as Record<string, Object>;
    let worktreeId = '';
    let worktreeValue: Object = snapshot['worktree'];
    if (typeof worktreeValue === 'string') {
      worktreeId = worktreeValue;
    }
    let tabsValue: Object = snapshot['tabs'];
    if (tabsValue === null || tabsValue === undefined || !Array.isArray(tabsValue)) {
      return;
    }
    let tabs = tabsValue as Array<Object>;
    let best: WorktreeAcc | null = null;
    for (let i = 0; i < tabs.length; i++) {
      let tabValue: Object = tabs[i];
      if (tabValue === null || tabValue === undefined || typeof tabValue !== 'object'
        || Array.isArray(tabValue)) {
        continue;
      }
      let tab = tabValue as Record<string, Object>;
      let tabWorktree: Object = tab['worktreeId'];
      if (worktreeId.length === 0 && typeof tabWorktree === 'string') {
        worktreeId = tabWorktree;
      }
      let state = readTabState(tab);
      let title = readStringMember(tab, 'displayName');
      if (title.length === 0) {
        title = readStringMember(tab, 'title');
      }
      let repo = readStringMember(tab, 'repo');
      if (best === null) {
        best = { worktreeId: worktreeId, title: title, repo: repo, state: state };
      } else {
        // 优先保留"更像 agent"的 tab：有状态者优先，其次有标题者优先
        if (state.length > 0 && best.state.length === 0) {
          best.state = state;
        }
        if (best.title.length === 0 && title.length > 0) {
          best.title = title;
        }
        if (best.repo.length === 0 && repo.length > 0) {
          best.repo = repo;
        }
      }
    }
    if (worktreeId.length === 0) {
      return;
    }
    if (best !== null) {
      best.worktreeId = worktreeId;
      hostAcc.set(worktreeId, best);
    }
  }

  private rebuildRows(): void {
    let rows: JumpRow[] = [];
    let multipleHosts = this.hosts.length > 1;
    this.accByHost.forEach((hostAcc: Map<string, WorktreeAcc>, hostId: string): void => {
      let hostName = hostId;
      for (let i = 0; i < this.hosts.length; i++) {
        if (this.hosts[i].id === hostId) {
          hostName = this.hosts[i].name;
          break;
        }
      }
      hostAcc.forEach((acc: WorktreeAcc): void => {
        let where = acc.repo;
        if (multipleHosts && hostName.length > 0) {
          where = where.length > 0 ? `${where} · ${hostName}` : hostName;
        }
        rows.push({
          hostId: hostId,
          hostName: hostName,
          worktreeId: acc.worktreeId,
          title: acc.title.length > 0 ? acc.title : acc.worktreeId,
          repo: where,
          state: acc.state
        });
      });
    });
    rows.sort((a: JumpRow, b: JumpRow): number => stateRank(a.state) - stateRank(b.state));
    this.agentRows = rows;
  }

  stateLabel(state: string): string {
    if (state === 'working') {
      return '工作中';
    }
    if (state === 'monitoring') {
      return '监控后台任务';
    }
    if (state === 'waiting' || state === 'interactivePrompt') {
      return '等待输入';
    }
    if (state === 'blocked' || state === 'permission') {
      return '已阻塞';
    }
    if (state === 'done') {
      return '已完成';
    }
    if (state === 'failed') {
      return '失败';
    }
    if (state === 'interrupted') {
      return '已中断';
    }
    return '空闲';
  }

  stateDotColor(state: string): string {
    if (isNeedsYou(state)) {
      return DOT_NEEDS_YOU;
    }
    if (state === 'working' || state === 'monitoring') {
      return DOT_WORKING;
    }
    if (state === 'done') {
      return DOT_DONE;
    }
    return this.pal().textMuted;
  }

  statusTextColor(state: string): string {
    // 上游：只有 permission/failed/done 让文字带状态色，运行中保持安静
    if (isNeedsYou(state)) {
      return DOT_NEEDS_YOU;
    }
    if (state === 'done') {
      return DOT_DONE;
    }
    return this.pal().textSecondary;
  }

  // ---------------------------------------------------------------- actions

  openHostDetail(hostId: string): void {
    router.pushUrl({ url: 'pages/HostDetail', params: { 'hostId': hostId } }).catch(() => {});
  }

  openSession(hostId: string, worktreeId: string): void {
    let route = `/h/${hostId}/session/${worktreeId}`;
    router.pushUrl({ url: 'pages/ShellScreen', params: { 'hostId': hostId, 'route': route } }).catch(() => {});
  }

  openPairScan(): void {
    router.pushUrl({ url: 'pages/PairScan' }).catch(() => {});
  }

  openNewWorkspace(): void {
    let hostId = this.firstOnlineHostId();
    if (hostId.length === 0) {
      return;
    }
    router.pushUrl({ url: 'pages/ShellScreen', params: { 'hostId': hostId } }).catch(() => {});
  }

  async removeHost(host: HostMeta): Promise<void> {
    let answer = await promptAction.showDialog({
      title: '移除主机',
      message: `要移除“${host.name}”吗？之后可重新配对。`,
      buttons: [{ text: '取消', color: '#898989' }, { text: '移除', color: '#ff6568' }]
    });
    if (answer.index !== 1) {
      return;
    }
    try {
      await deleteHost(getContext(this) as common.Context, host.id);
      await deletePageStorage(getContext(this) as common.Context, host.id);
      this.reload();
    } catch (e) {
      // 忽略：目录刷新会在下次 onPageShow 重试
    }
  }

  // ----------------------------------------------------------------- paint

  @Builder
  tabHeader(title: string) {
    Row() {
      Text(title)
        .fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.pal().textPrimary)
        .maxLines(1)
        .layoutWeight(1)
    }
    .width('100%')
    .height(44)
    .padding({ left: 20, right: 12 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  sectionHeading(title: string, aside: string, first: boolean) {
    Row() {
      Text(title)
        .fontSize(15 * this.fontScale)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .maxLines(1)
      if (aside.length > 0) {
        Text(aside)
          .fontSize(13)
          .fontColor(this.pal().textMuted)
          .margin({ left: 8 })
          .alignSelf(ItemAlign.End)
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Bottom)
    .padding({ left: 4, right: 4 })
    .margin({ top: first ? 4 : 20, bottom: 7 })
  }

  @Builder
  agentDot(state: string) {
    Circle({ width: 9, height: 9 }).fill(this.stateDotColor(state));
  }

  @Builder
  jumpRow(row: JumpRow) {
    Row() {
      Column() {
        this.agentDot(row.state)
      }
      .width(24)
      .height(20)
      .margin({ top: 9 })
      .justifyContent(FlexAlign.Center)

      Column() {
        Text(row.title)
          .fontSize(16 * this.fontScale)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Row() {
          Text(this.stateLabel(row.state))
            .fontSize(14)
            .fontColor(this.statusTextColor(row.state))
            .maxLines(1)
          if (row.repo.length > 0) {
            Text(`${this.stateLabel(row.state).length > 0 ? ' · ' : ''}${row.repo}`)
              .fontSize(14)
              .fontColor(this.pal().textSecondary)
              .maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis })
              .layoutWeight(1)
          }
        }
        .width('100%')
        .margin({ top: 1 })
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ top: 9, bottom: 9 })
      .layoutWeight(1)

      Row() {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([this.pal().textMuted])
      }
      .padding({ left: 10, right: 14 })
      .margin({ top: 9 })
    }
    .width('100%')
    .padding({ left: 16 })
    .alignItems(VerticalAlign.Top)
    .onClick(() => {
      this.openSession(row.hostId, row.worktreeId);
    })
  }

  @Builder
  desktopRow(host: HostMeta) {
    Row() {
      // 机器磁贴（上游 tile 30x30 圆角 10 + 角落连接点）
      Stack({ alignContent: Alignment.BottomEnd }) {
        Column()
          .width(30)
          .height(30)
          .borderRadius(10)
          .backgroundColor(this.pal().bgRaised)
        SymbolGlyph($r('sys.symbol.computer'))
          .fontSize(17)
          .fontColor([this.pal().textPrimary])
        Circle({ width: 14, height: 14 })
          .fill(this.online[host.id] === true ? this.pal().statusGreen : this.pal().textMuted)
          .stroke(this.pal().bgPanel)
          .strokeWidth(2)
          .translate({ x: 5, y: 5 })
      }
      .width(30)
      .height(30)
      .margin({ top: 9, right: 11 })

      Column() {
        Text(host.name)
          .fontSize(16 * this.fontScale)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Row() {
          Text(this.online[host.id] === true ? '已连接' : (this.connecting ? '正在连接' : '离线'))
            .fontSize(14)
            .fontColor(this.online[host.id] === true
              ? this.pal().textSecondary
              : (this.connecting ? this.pal().statusAmber : this.pal().textSecondary))
            .maxLines(1)
          Text(` · ${host.endpoint}`)
            .fontSize(14)
            .fontColor(this.pal().textSecondary)
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
            .layoutWeight(1)
        }
        .width('100%')
        .margin({ top: 1 })
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ top: 9, bottom: 9 })
      .layoutWeight(1)

      Row() {
        SymbolGlyph($r('sys.symbol.chevron_right'))
          .fontSize(16)
          .fontColor([this.pal().textMuted])
      }
      .padding({ left: 10, right: 14 })
      .margin({ top: 9 })
    }
    .width('100%')
    .padding({ left: 16 })
    .alignItems(VerticalAlign.Top)
    .onClick(() => {
      this.openHostDetail(host.id);
    })
    .gesture(LongPressGesture().onAction(() => {
      this.removeHost(host);
    }))
  }

  @Builder
  hairline(indent: number) {
    Row()
      .height(0.5)
      .backgroundColor(this.pal().borderSubtle)
      .margin({ left: indent })
      .width('100%')
  }

  @Builder
  feedTab() {
    Column() {
      this.tabHeader('动态')
      if (this.hosts.length === 0) {
        this.homeEmptyState()
      } else {
        Scroll() {
          Column() {
            if (this.agentRows.length > 0) {
              this.sectionHeading('智能体', `${this.activeCountText()}`, true)
              Column() {
                ForEach(this.agentRows, (row: JumpRow, index: number) => {
                  Column() {
                    if (index > 0) {
                      this.hairline(40)
                    }
                    this.jumpRow(row)
                  }
                  .width('100%')
                }, (row: JumpRow, index: number) => `${index}-${row.hostId}-${row.worktreeId}`)
              }
              .width('100%')
              .borderRadius(16)
              .backgroundColor(this.pal().bgPanel)
              .clip(true)
            }

            this.sectionHeading('台式机', '', this.agentRows.length === 0)
            Column() {
              ForEach(this.hosts, (host: HostMeta, index: number) => {
                Column() {
                  if (index > 0) {
                    this.hairline(56)
                  }
                  this.desktopRow(host)
                }
                .width('100%')
              }, (host: HostMeta, index: number) => `${index}-${host.id}`)
            }
            .width('100%')
            .borderRadius(16)
            .backgroundColor(this.pal().bgPanel)
            .clip(true)
            .margin({ bottom: TAB_BAR_HEIGHT + 24 })
          }
          .width('100%')
          .padding({ left: 16, right: 16 })
        }
        .scrollBar(BarState.Off)
        .width('100%')
        .layoutWeight(1)
        .align(Alignment.Top)
      }
    }
    .width('100%')
    .height('100%')
  }

  activeCountText(): string {
    let count = 0;
    for (let i = 0; i < this.agentRows.length; i++) {
      if (this.agentRows[i].state !== 'done' && !isNeedsYou(this.agentRows[i].state)) {
        count++;
      }
    }
    if (count > 0) {
      return `${count} 个活跃`;
    }
    return '';
  }

  @Builder
  stepRow(index: number, title: string, desc: string) {
    Row({ space: 14 }) {
      Text(`${index}`)
        .fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .width(26)
        .height(26)
        .borderRadius(13)
        .backgroundColor(this.pal().bgRaised)
        .textAlign(TextAlign.Center)
      Column({ space: 2 }) {
        Text(title)
          .fontSize(17 * this.fontScale)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(desc)
          .fontSize(15)
          .lineHeight(20)
          .fontColor(this.pal().textSecondary)
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1)
    }
    .width('100%')
    .alignItems(VerticalAlign.Top)
    .padding(16)
  }

  @Builder
  homeEmptyState() {
    Scroll() {
      Column() {
        Column() {
          Image($r('app.media.icon'))
            .width(44)
            .height(44)
            .borderRadius(10)
          Text('连接桌面')
            .fontSize(28 * this.fontScale)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.pal().textPrimary)
            .textAlign(TextAlign.Center)
            .margin({ top: 26, bottom: 10 })
          Text('与电脑上的 Orca 配对，即可在手机上查看智能体、进入任意终端并推进工作。')
            .fontSize(17)
            .lineHeight(24)
            .fontColor(this.pal().textSecondary)
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ left: 8, right: 8 })
        .margin({ bottom: 34 })

        Column() {
          this.stepRow(1, '打开 Orca 桌面应用', '前往“设置” → “移动端”，生成配对二维码。')
          this.hairline(46)
          this.stepRow(2, '扫描二维码', 'Tap Pair desktop below, then point your camera at the QR code on your screen.')
          this.hairline(46)
          this.stepRow(3, '已连接', '桌面将显示在这里。所有数据均采用端到端加密。')
        }
        .width('100%')
        .borderRadius(16)
        .backgroundColor(this.pal().bgPanel)
        .clip(true)

        Row({ space: 8 }) {
          SymbolGlyph($r('sys.symbol.qrcode'))
            .fontSize(18)
            .fontColor([this.pal().onAccent])
          Text('Pair desktop')
            .fontSize(16)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.pal().onAccent)
        }
        .alignItems(VerticalAlign.Center)
        .justifyContent(FlexAlign.Center)
        .constraintSize({ minHeight: 48 })
        .padding({ left: 22, right: 22 })
        .borderRadius(12)
        .backgroundColor(this.pal().accentBlue)
        .margin({ top: 22 })
        .onClick(() => {
          this.openPairScan();
        })
      }
      .width('100%')
      .padding(16)
      .constraintSize({ minHeight: '100%' })
      .justifyContent(FlexAlign.Center)
    }
    .scrollBar(BarState.Off)
    .width('100%')
    .layoutWeight(1)
  }

  @Builder
  tabEmptyState(icon: Resource, title: string, message: string) {
    Column({ space: 6 }) {
      SymbolGlyph(icon)
        .fontSize(28)
        .fontColor([this.pal().textMuted])
      Text(title)
        .fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .margin({ top: 6 })
      Text(message)
        .fontSize(15)
        .lineHeight(20)
        .fontColor(this.pal().textSecondary)
        .textAlign(TextAlign.Center)
        .padding({ left: 24, right: 24 })
    }
    .width('100%')
    .padding({ top: 28, bottom: 28 })
    .margin({ top: 32 })
  }

  @Builder
  usageTab() {
    Column() {
      this.tabHeader('使用情况')
      Scroll() {
        Column() {
          if (this.hosts.length === 0) {
            this.tabEmptyState($r('sys.symbol.gauge_with_dots_needle_33percent'), '暂无使用情况',
              '请先配对桌面，才能查看智能体账户使用情况。')
          } else if (this.onlineCount() === 0) {
            this.tabEmptyState($r('sys.symbol.gauge_with_dots_needle_33percent'), '暂无使用情况',
              `请连接 ${this.hosts[0].name}，才能查看智能体账户使用情况。`)
          } else {
            this.tabEmptyState($r('sys.symbol.gauge_with_dots_needle_33percent'), '暂无使用情况',
              '请在桌面的“设置 → 账户”中添加账户。')
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: TAB_BAR_HEIGHT + 24 })
      }
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  automationsTab() {
    Column() {
      this.tabHeader('自动化')
      Scroll() {
        Column() {
          if (this.hosts.length === 0) {
            this.tabEmptyState($r('sys.symbol.calendar_badge_clock'), '安排智能体工作',
              '请先配对桌面，才能查看和运行自动化。')
          } else if (this.onlineCount() === 0) {
            this.tabEmptyState($r('sys.symbol.calendar_badge_clock'), '安排智能体工作',
              `请连接 ${this.hosts[0].name}，才能查看和运行自动化。`)
          } else {
            this.tabEmptyState($r('sys.symbol.calendar_badge_clock'), '暂无自动化',
              '轻点 + 以安排智能体。')
          }
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: TAB_BAR_HEIGHT + 24 })
      }
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  settingsTab() {
    Column() {
      this.tabHeader('设置')
      Scroll() {
        Column() {
          Column() {
            ForEach(SETTINGS_ROWS, (row: SettingsRow, index: number) => {
              Column() {
                if (index > 0) {
                  this.hairline(46)
                }
                Row({ space: 11 }) {
                  SymbolGlyph(row.icon)
                    .fontSize(18)
                    .fontColor([this.pal().textSecondary])
                  Text(row.label)
                    .fontSize(16 * this.fontScale)
                    .fontColor(this.pal().textPrimary)
                    .maxLines(1)
                    .layoutWeight(1)
                  SymbolGlyph($r('sys.symbol.chevron_right'))
                    .fontSize(14)
                    .fontColor([this.pal().textMuted])
                }
                .width('100%')
                .padding({ top: 12, bottom: 12, left: 16, right: 14 })
                .onClick(() => {
                  router.pushUrl({ url: row.target }).catch(() => {});
                })
              }
              .width('100%')
            }, (row: SettingsRow, index: number) => `${index}-${row.target}`)
          }
          .width('100%')
          .borderRadius(16)
          .backgroundColor(this.pal().bgPanel)
          .clip(true)
          .margin({ top: 8 })
        }
        .width('100%')
        .padding({ left: 16, right: 16, bottom: TAB_BAR_HEIGHT + 24 })
      }
      .scrollBar(BarState.Off)
      .width('100%')
      .layoutWeight(1)
      .align(Alignment.Top)
    }
    .width('100%')
    .height('100%')
  }

  @Builder
  tabBar() {
    Row() {
      ForEach(TAB_SPECS, (tab: TabSpec, index: number) => {
        Column({ space: 3 }) {
          Stack({ alignContent: Alignment.TopStart }) {
            SymbolGlyph(tab.icon)
              .fontSize(25)
              .fontColor([this.activeTab === tab.id ? this.pal().textPrimary : this.pal().textMuted])
            if (tab.id === 'feed' && this.needsYouCount() > 0) {
              Text(`${this.needsYouCount()}`)
                .fontSize(11)
                .fontWeight(FontWeight.Bold)
                .fontColor('#000000')
                .constraintSize({ minWidth: 17 })
                .height(17)
                .padding({ left: 4, right: 4 })
                .borderRadius(9)
                .backgroundColor(this.pal().statusAmber)
                .textAlign(TextAlign.Center)
                .offset({ x: 20, y: -4 })
                .border({ width: 1.5, color: this.pal().bgBase })
            }
          }
          .width(30)
          .height(26)
          Text(tab.label)
            .fontSize(10.5)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.activeTab === tab.id ? this.pal().textPrimary : this.pal().textMuted)
            .maxLines(1)
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .padding({ top: 2 })
        .onClick(() => {
          this.activeTab = tab.id;
        })
      }, (tab: TabSpec, index: number) => `${index}-${tab.id}`)
    }
    .width('100%')
    .height(TAB_BAR_HEIGHT)
    .padding({ top: 6, left: 4, right: 4, bottom: 8 })
    .border({ width: { top: 0.5 }, color: { top: this.pal().borderSubtle } })
    .backgroundColor(this.pal().bgBase)
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  fab() {
    Column({ space: 8 }) {
      if (this.fabDisabled() && !this.connecting) {
        Text('Connect a desktop to start new work.')
          .fontSize(13)
          .fontColor(this.pal().textSecondary)
          .backgroundColor(this.pal().bgRaised)
          .padding({ left: 10, right: 10, top: 5, bottom: 5 })
          .borderRadius(999)
          .constraintSize({ maxWidth: 220 })
      }
      Stack() {
        Column()
          .width(FAB_SIZE)
          .height(FAB_SIZE)
          .borderRadius(28)
          .backgroundColor(this.pal().accentBlue)
          .shadow({ radius: 10, color: 'rgba(0,0,0,0.3)', offsetY: 5 })
          .opacity(this.fabDisabled() ? 0.4 : 1)
        SymbolGlyph($r('sys.symbol.plus'))
          .fontSize(26)
          .fontColor([this.pal().onAccent])
          .opacity(this.fabDisabled() ? 0.4 : 1)
      }
      .width(FAB_SIZE)
      .height(FAB_SIZE)
      .onClick(() => {
        if (!this.fabDisabled()) {
          this.openNewWorkspace();
        }
      })
    }
    .alignItems(HorizontalAlign.End)
    .margin({ right: 18, bottom: TAB_BAR_HEIGHT + 16 })
  }

  fabDisabled(): boolean {
    return this.hosts.length === 0 || this.onlineCount() === 0;
  }

  build() {
    Column() {
      Stack({ alignContent: Alignment.BottomEnd }) {
        Column() {
          if (this.activeTab === 'feed') {
            this.feedTab()
          } else if (this.activeTab === 'usage') {
            this.usageTab()
          } else if (this.activeTab === 'automations') {
            this.automationsTab()
          } else {
            this.settingsTab()
          }
        }
        .width('100%')
        .height('100%')

        if (this.activeTab === 'feed' && this.loaded && this.hosts.length > 0) {
          this.fab()
        }
      }
      .width('100%')
      .layoutWeight(1)

      this.tabBar()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pal().bgBase)
  }
}

// ------------------------------------------------------------- loose parsing

function readStringMember(obj: Record<string, Object>, name: string): string {
  let value: Object = obj[name];
  return typeof value === 'string' ? value : '';
}

function readStateOfObject(value: Object): string {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }
  let obj = value as Record<string, Object>;
  let stateValue: Object = obj['state'];
  return typeof stateValue === 'string' ? stateValue : '';
}

/** 宽松 agent 状态读取：agentStatus.state → chatStatus.state → tab.state。 */
function readTabState(tab: Record<string, Object>): string {
  let fromAgentStatus = readStateOfObject(tab['agentStatus']);
  if (fromAgentStatus.length > 0) {
    return fromAgentStatus;
  }
  let fromChatStatus = readStateOfObject(tab['chatStatus']);
  if (fromChatStatus.length > 0) {
    return fromChatStatus;
  }
  return readStateOfObject(tab['state']);
}

/** 上游 homeAgentNeedsYou：等待输入/被阻塞/失败的智能体需要用户处理。 */
function isNeedsYou(state: string): boolean {
  return state === 'waiting' || state === 'interactivePrompt' || state === 'blocked'
    || state === 'permission' || state === 'failed';
}

/** 上游 attentionRank：需要处理的排最前，其后是已完成，再后是运行中。 */
function stateRank(state: string): number {
  if (isNeedsYou(state)) {
    return 0;
  }
  if (state === 'done') {
    return 1;
  }
  if (state === 'working' || state === 'monitoring') {
    return 2;
  }
  return 3;
}
