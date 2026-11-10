import { lucideColorFilter } from '../settings/LucideColor';
import { playHapticFeedback } from '../settings/HapticFeedback';
import { enterHomePrewarm, leaveHomePrewarm, scheduleHomePrewarm } from '../webshell/HomeShellPrewarm';
import { uiText } from '../settings/NativeUi';
import { router, promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { pasteboard } from '@kit.BasicServicesKit';
import { parseLaunchRoute } from '../navigation/LaunchRoute';
import { ShellRoute, shellRouterParams } from '../navigation/ShellRoute';
import { removeDesktop } from '../storage/HostRemoval';
import { DeviceRowStore, HomeWorktreeCounts } from '../storage/DeviceRowStore';
import { listHosts, HostMeta, updateHostMachine } from '../storage/HostStore';
import { HostMachineDescriptor, hostMachineLine, readHostMachineDescriptor } from '../storage/HostMachine';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, HomeDesktopConnection, reconcileHomeDesktopConnections, retainDesktopConnection,
  refreshDesktopConnection } from '../transport/DesktopConnections';
import { HomeWorktree, readHomeCatalog } from '../home/HomeCatalog';
import { AgentDesktop, AgentListRow, HomeAgentEntry, activeAgents, agentPreview, agentRowRevision, agentTimeAgo, agentsNeedingYou } from '../home/AgentListModel';
import { AgentListRows } from '../home/AgentListRows';
import { AgentActivityBatch, AgentActivityWrites, planAgentActivity } from '../home/AgentActivityWrites';
import { AgentActions } from '../home/AgentActions';
import { AgentsTab } from '../home/AgentsTab';
import { DesktopActions } from '../home/DesktopActions';
import { appVersion, describeDesktopConnection, DesktopConnectionVerdict, endpointLabel } from '../diagnostics/ConnectionDiagnostics';
import { appendLog, LOG_LEVEL_INFO } from '../diagnostics/ConnectionLogStore';
import { HomeUsageCard, HomeUsageWindow, HomeAutomation, HomeAutomationRun, homeUsageEventType, readHomeUsage, readHomeAutomations,
  readHomeAutomationRuns, homeAutomationToggleParams } from '../home/HomeAccountUsage';
import { homeAutomationSchedule, homeUsageResetCountdown } from '../home/HomeTabPresentation';
import { SETTINGS_LINK_ITEMS, SETTINGS_MENU_ITEMS, SettingsMenuItem } from '../settings/SettingsMenu';
import { PendingCredentialCleanupCard } from '../settings/PendingCredentialCleanupCard';
import { loadMobileOnboardingSteps } from '../onboarding/MobileOnboardingPlan';
import { recoverRelayPairings } from '../transport/RelayPairing';
import { HomeStats, readHomeStats, totalHomeStats } from '../home/HomeStats';
import { ShellSurface, ShellSurfaceBack } from '../webshell/ShellSurface';

// upstream src/theme/mobile-theme.ts: darkColors / lightColors（外壳用到的子集）
interface HomePalette {
  bgBase: string;
  bgPanel: string;
  sheetGroup: string;
  bgRaised: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accentBlue: string;
  onAccent: string;
  translucentFill: string;
  skillTokenSurface: string;
  statusGreen: string;
  statusAmber: string;
  statusRed: string;
}

interface DesktopRowPresentation {
  host: HostMeta;
  verdict: DesktopConnectionVerdict;
}

interface DesktopStatusDetailPresentation { detail: string; }

const PALETTE_DARK: HomePalette = {
  bgBase: '#0a0a0a',
  bgPanel: '#171717',
  sheetGroup: '#262626',
  bgRaised: '#262626',
  borderSubtle: '#2c2c2c', // rgba(255,255,255,0.07) over #0a0a0a/#171717
  textPrimary: '#fafafa',
  textSecondary: '#acacac',
  textMuted: '#898989',
  accentBlue: '#3276f2',
  onAccent: '#ffffff',
  translucentFill: 'rgba(120, 120, 128, 0.36)',
  skillTokenSurface: 'rgba(59, 130, 246, 0.2)',
  statusGreen: '#86efac',
  statusAmber: '#eab308',
  statusRed: '#ff6568'
};

const PALETTE_LIGHT: HomePalette = {
  bgBase: '#ffffff',
  bgPanel: '#fafafa',
  sheetGroup: '#ffffff',
  bgRaised: '#f5f5f5',
  borderSubtle: '#e5e5e5',
  textPrimary: '#0a0a0a',
  textSecondary: '#696969',
  textMuted: '#696969',
  accentBlue: '#225be3',
  onAccent: '#ffffff',
  translucentFill: 'rgba(120, 120, 128, 0.16)',
  skillTokenSurface: 'rgba(59, 130, 246, 0.12)',
  statusGreen: '#147638',
  statusAmber: '#ca8a04',
  statusRed: '#e40014'
};

interface TabSpec {
  id: string;
  label: string;
  icon: Resource;
}
interface HomeSectionHeading { title: string; aside: string; first: boolean; }

const USAGE_METER_LABEL_MIN_WIDTH = 26;
const USAGE_METER_FONT_SIZE = 13;
const USAGE_METER_GAP = 10;

interface WorktreeCountProof { value: HomeWorktreeCounts; save: 'needed' | 'pending' | 'saved'; }
interface AgentCatalog { counts: WorktreeCountProof; entries: HomeAgentEntry[] | null; at: number; }
interface LiveDesktopMachine { pairedAt: number; endpoint: string; descriptor: HostMachineDescriptor; }

interface HostRuntime {
  lease: DesktopConnectionLease;
  unobserve: () => void;
  client: SpikeRpcClient | null;
  online: boolean;
  connecting: boolean;
  refreshTimer: number;
  catalogState: string;
  catalogPending: Promise<void> | null;
  catalogRefetch: Promise<void> | null;
  usageRevision: number;
  automationPending: Promise<void> | null;
  automationFetchedAt: number;
}

const TAB_SPECS: TabSpec[] = [
  { id: 'feed', label: '动态', icon: $r('app.media.lucide_list') },
  { id: 'agents', label: '智能体', icon: $r('app.media.lucide_bot') },
  { id: 'usage', label: '使用情况', icon: $r('app.media.lucide_gauge') },
  { id: 'automations', label: '自动化', icon: $r('app.media.lucide_calendar_clock') },
  { id: 'settings', label: '设置', icon: $r('app.media.lucide_settings') }
];

const FAB_SIZE = 56;
const TAB_BAR_HEIGHT = 64; // paddingTop 6 + 图标 26 + 文本 + paddingBottom 8（上游 52 + inset）

function withoutDesktop<T>(values: Record<string, T>, hostId: string): Record<string, T> {
  let next: Record<string, T> = {};
  Object.keys(values).forEach((id: string): void => { if (id !== hostId) { next[id] = values[id]; } });
  return next;
}

@Entry
@Component
struct Home {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @State activeTab: string = 'feed';
  @State hosts: HostMeta[] = [];
  @State loaded: boolean = false;
  @State online: Record<string, boolean> = {};
  @State hostPhases: Record<string, string> = {};
  @State hostActionTarget: HostMeta | null = null;
  @State hostSheetOpen: boolean = false;
  private hostAction: string = '';
  @State agentActionTarget: AgentListRow | null = null;
  @State agentSheetOpen: boolean = false;
  private agentAction: string = '';
  @State connecting: boolean = false;
  @State activeAgentRows: AgentListRow[] = [];
  @State agentsNeedingYouCount: number = 0;
  @State agentDesktops: AgentDesktop[] = [];
  @State summaries: Record<string, string> = {};
  @State desktopMachines: Record<string, LiveDesktopMachine> = {};
  @State needsYouByDesktop: Record<string, number> = {};
  @State loadError: string = '';
  @State tabHostPicker: string = '';
  @State tabHostPickerOpen: boolean = false;
  @State offeredActionHosts: string[] = [];
  @State workspaceDrawer: ShellRoute | null = null;
  private workspaceDrawerOwner: number = 0;
  @State workspacePageVisible: boolean = true;
  private pickerAction: ShellRoute | null = null;
  private workspaceBack: ShellSurfaceBack = new ShellSurfaceBack();
  @State usageDesktopId: string = '';
  @State automationDesktopId: string = '';
  @State usageRefreshing: string[] = [];
  @State homeNow: number = Date.now();
  private tabClock: number = -1;
  @State usageByHost: Record<string, HomeUsageCard[]> = {};
  @State automationsByHost: Record<string, HomeAutomation[]> = {};
  @State usageErrors: Record<string, string> = {};
  @State automationErrors: Record<string, string> = {};
  @State automationRunsByHost: Record<string, HomeAutomationRun[]> = {};
  @State statsTotal: HomeStats | null = null;
  private statsByHost: Record<string, HomeStats> = {};
  @State automationBusy: string[] = [];
  @State automationRequested: Record<string, boolean> = {};
  private runtimes: Map<string, HostRuntime> = new Map();
  private agentCatalogs: Map<string, AgentCatalog> = new Map();
  private agentActivityWrites: AgentActivityWrites = new AgentActivityWrites((): void => this.rebuildRows());
  private epoch: number = 0;
  private visible: boolean = false;
  private appInForeground: boolean = true;
  private loadEpoch: number = 0;
  private autoConnectionRevision: number = 0;
  private onboardingChecked: boolean = false;
  private onboardingSteps: string[] = [];
  private onboardingNavigating: boolean = false;
  private readonly installedVersion: string = appVersion();

  // ---------------------------------------------------------------- helpers

  pal(): HomePalette {
    return this.scheme === 'light' ? PALETTE_LIGHT : PALETTE_DARK;
  }



  private onAppBackground = (): void => {
    this.appInForeground = false;
    this.updateTabClock();
    this.pauseHomeCatalogs();
  };
  private onAppForeground = (): void => {
    this.appInForeground = true;
    this.updateTabClock();
    if (this.visible) {
      this.recoverPairings();
      this.syncHomeAutoConnections();
      enterHomePrewarm(); this.schedulePrewarm();
      this.runtimes.forEach((rt: HostRuntime, id: string): void => {
        if (rt.client && rt.online) { this.fetchCatalog(rt.client, id, this.epoch); }
      });
    }
  };

  aboutToAppear(): void {
    let events = (getContext(this) as common.UIAbilityContext).eventHub;
    events.on('orcaForeground', this.onAppForeground);
    events.on('orcaBackground', this.onAppBackground);
  }

  onPageShow(): void {
    this.visible = true; enterHomePrewarm();
    this.workspacePageVisible = true;
    this.updateTabClock();
    let uri = AppStorage.get<string>('pendingLaunchUri') ?? '';
    AppStorage.setOrCreate('pendingLaunchUri', '');
    let destination = parseLaunchRoute(uri);
    if (destination) {
      AppStorage.setOrCreate('explicitLaunchNavigation', true);
      this.onboardingChecked = true;
      let page = destination.page;
      let params = destination.params;
      setTimeout((): void => { router.pushUrl({ url: page, params: params }).catch(() => {}); }, 0);
    }
    this.reload();
    this.recoverPairings();
  }

  onPageHide(): void {
    this.visible = false; leaveHomePrewarm();
    this.workspacePageVisible = false;
    this.updateTabClock();
    this.loadEpoch++;
    this.pauseHomeCatalogs();
  }

  private pauseHomeCatalogs(): void {
    this.runtimes.forEach((runtime: HostRuntime): void => {
      if (runtime.refreshTimer >= 0) { clearTimeout(runtime.refreshTimer); runtime.refreshTimer = -1; }
    });
  }

  aboutToDisappear(): void {
    let events = (getContext(this) as common.UIAbilityContext).eventHub;
    events.off('orcaForeground', this.onAppForeground);
    events.off('orcaBackground', this.onAppBackground);
    if (this.visible) { leaveHomePrewarm(); }
    this.visible = false;
    this.updateTabClock();
    this.loadEpoch++;
    this.stopProbes();
  }

  onBackPress(): boolean {
    if (this.workspaceDrawer) {
      if (!this.workspaceBack.handle()) { this.closeWorkspaceDrawer(this.workspaceDrawerOwner); }
      return true;
    }
    if (this.hostSheetOpen) { this.hostSheetOpen = false; return true; }
    if (this.agentSheetOpen) { this.agentSheetOpen = false; return true; }
    if (this.tabHostPickerOpen) { this.tabHostPickerOpen = false; return true; }
    if (this.activeTab !== 'feed') { this.activeTab = 'feed'; this.updateTabClock(); return true; }
    return false;
  }

  reload(): void {
    let loadEpoch = ++this.loadEpoch;
    let context = getContext(this) as common.Context;
    listHosts(context).then((hosts: HostMeta[]): void => {
      if (!this.visible || loadEpoch !== this.loadEpoch) { return; }
      this.hosts = hosts.slice().sort((left: HostMeta, right: HostMeta): number => right.lastConnected - left.lastConnected);
      this.agentCatalogs.forEach((catalog: AgentCatalog, id: string): void => {
        if (!hosts.some((host: HostMeta): boolean => host.id === id && host.lastConnected === catalog.counts.value.pairedAt)) {
          this.agentCatalogs.delete(id);
        }
      });
      this.statsTotal = totalHomeStats(this.statsByHost, hosts.map((host: HostMeta): string => host.id));
      this.loaded = true;
      this.loadError = '';
      if (!this.openPendingOnboarding(context)) {
        this.syncDesktops(); this.schedulePrewarm(); this.restoreWorktreeCounts(context, loadEpoch);
      }
    }).catch((_e: Error) => {
      if (!this.visible || loadEpoch !== this.loadEpoch) { return; }
      this.loaded = true;
      this.loadError = '无法读取已配对桌面，请重试。';
    });
  }

  private restoreWorktreeCounts(context: common.Context, loadEpoch: number): void {
    this.hosts.forEach((host: HostMeta): void => {
      if (this.agentCatalogs.has(host.id)) { return; }
      new DeviceRowStore(context, host.id).readHomeCounts(host.lastConnected).then((counts: HomeWorktreeCounts | null): void => {
        if (!counts || !this.visible || loadEpoch !== this.loadEpoch || this.agentCatalogs.has(host.id)) { return; }
        this.agentCatalogs.set(host.id, { counts: { value: counts, save: 'saved' }, entries: null, at: 0 });
        this.refreshSummaries();
      }).catch(() => {});
    });
  }

  private recoverPairings(): void {
    let context = getContext(this) as common.Context;
    recoverRelayPairings(context).then((hostIds: string[]): void => {
      if (hostIds.length === 0) { return; }
      hostIds.forEach((id: string): void => refreshDesktopConnection(id, 'paired'));
      if (this.visible) { this.reload(); }
    }).catch(() => {});
  }

  private openPendingOnboarding(context: common.Context): boolean {
    if (this.hosts.length === 0) { return false; }
    if (AppStorage.get<boolean>('explicitLaunchNavigation') === true) {
      this.onboardingChecked = true; this.onboardingSteps = []; return false;
    }
    if (!this.onboardingChecked) {
      this.onboardingChecked = true;
      this.onboardingSteps = loadMobileOnboardingSteps(context);
    }
    if (this.onboardingSteps.length === 0) { return false; }
    if (!this.onboardingNavigating) {
      this.onboardingNavigating = true;
      router.replaceUrl({ url: 'pages/MobileOnboarding', params: { 'steps': this.onboardingSteps.join(',') } }).catch(() => {
        this.onboardingNavigating = false;
        if (this.visible) { this.loadError = '无法打开首次设置，请重试'; }
      });
    }
    return true;
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

  private tabDesktop(picked: string): HostMeta | null {
    return this.hosts.find((host: HostMeta): boolean => host.id === picked)
      ?? this.hosts.find((host: HostMeta): boolean => this.online[host.id] === true) ?? this.hosts[0] ?? null;
  }

  private tabDesktopRow(picked: string): HostMeta[] {
    let host = this.tabDesktop(picked);
    return host ? [host] : [];
  }

  private pickTabDesktop(hostId: string): void {
    if (this.tabHostPicker === 'usage') { this.usageDesktopId = hostId; }
    else if (this.tabHostPicker === 'automations') {
      this.automationDesktopId = hostId; this.refreshAutomations(hostId);
    } else if (this.offeredActionHosts.includes(hostId)
      && (this.tabHostPicker === 'workspace' || this.online[hostId] === true)) {
      let suffix = this.tabHostPicker === 'workspace' ? '/new-workspace' : '/tasks';
      this.pickerAction = { hostId: hostId, pathname: `/h/${encodeURIComponent(hostId)}${suffix}`, params: {} };
    }
    this.tabHostPickerOpen = false;
  }

  private showTabHostPicker(tab: string): void {
    this.tabHostPicker = tab; this.pickerAction = null; this.tabHostPickerOpen = true;
  }

  private finishTabHostPicker(): void {
    let route = this.pickerAction;
    this.tabHostPickerOpen = false; this.tabHostPicker = ''; this.pickerAction = null; this.offeredActionHosts = [];
    if (route && this.visible && this.hosts.some((host: HostMeta): boolean => host.id === route?.hostId)
      && (route.pathname.endsWith('/new-workspace') || this.online[route.hostId] === true)) {
      this.openPickedDesktop(route);
    }
  }

  private openPickedDesktop(route: ShellRoute): void {
    if (route.pathname.endsWith('/new-workspace')) {
      if (!this.workspaceDrawer) {
        leaveHomePrewarm(); this.workspaceDrawerOwner++; this.workspaceDrawer = route;
      }
    }
    else { this.openShellRoute(route); }
  }

  private closeWorkspaceDrawer(owner: number): boolean {
    if (!this.workspaceDrawer || this.workspaceDrawerOwner !== owner || !this.workspacePageVisible || !this.appInForeground) {
      return false;
    }
    this.workspaceDrawer = null;
    enterHomePrewarm(); this.schedulePrewarm();
    return true;
  }

  private updateTabClock(): void {
    let active = this.visible && this.appInForeground && this.activeTab !== 'settings';
    if (active && this.tabClock < 0) {
      this.homeNow = Date.now();
      this.tabClock = setInterval((): void => { this.homeNow = Date.now(); }, 60000);
    } else if (!active && this.tabClock >= 0) {
      clearInterval(this.tabClock); this.tabClock = -1;
    }
  }

  // ------------------------------------------------- live probes + tab data

  private syncConnState(): void {
    let next: Record<string, boolean> = {};
    let phases: Record<string, string> = {};
    let anyConnecting = false;
    this.runtimes.forEach((rt: HostRuntime, hostId: string): void => {
      next[hostId] = rt.online;
      phases[hostId] = rt.lease.connection.getPhase();
      if (rt.connecting) {
        anyConnecting = true;
      }
    });
    this.online = next;
    this.hostPhases = phases;
    this.connecting = anyConnecting;
    if (this.tabHostPickerOpen && this.tabHostPicker === 'tasks'
      && this.offeredActionHosts.some((hostId: string): boolean => next[hostId] !== true)) {
      this.tabHostPickerOpen = false;
    }
    this.rebuildRows();
  }

  private schedulePrewarm(): void {
    if (!this.visible || !this.appInForeground || this.workspaceDrawer) { return; }
    scheduleHomePrewarm(this.getUIContext(), getContext(this) as common.UIAbilityContext, this.hosts);
  }

  private stopProbes(): void {
    this.epoch++;
    Array.from(this.runtimes.keys()).forEach((id: string): void => this.releaseDesktop(id));
  }

  private syncDesktops(): void {
    let hosts = this.hosts;
    Array.from(this.runtimes.keys()).forEach((id: string): void => {
      if (!hosts.some((host: HostMeta): boolean => host.id === id)) { this.releaseDesktop(id); }
    });
    hosts.forEach((host: HostMeta): void => {
      let runtime = this.runtimes.get(host.id) ?? this.retainDesktop(host.id);
      runtime.lease.connection.updateProfile(host);
      let client = runtime.client;
      if (client && runtime.online) {
        this.fetchCatalog(client, host.id, this.epoch);
        this.fetchStats(client, host.id, this.epoch);
      }
    });
    this.syncHomeAutoConnections();
    this.syncConnState();
    if (this.activeTab === 'automations') { this.refreshAutomations(this.tabDesktop(this.automationDesktopId)?.id ?? ''); }
  }

  private syncHomeAutoConnections(): void {
    if (!this.visible || !this.appInForeground) { return; }
    let revision = ++this.autoConnectionRevision;
    let loadEpoch = this.loadEpoch;
    let candidates: HomeDesktopConnection[] = [];
    this.hosts.forEach((host: HostMeta): void => {
      let connection = this.runtimes.get(host.id)?.lease.connection;
      if (connection) { candidates.push({ host: host, connection: connection }); }
    });
    let current = (): boolean => this.visible && this.appInForeground && revision === this.autoConnectionRevision
      && loadEpoch === this.loadEpoch;
    reconcileHomeDesktopConnections(candidates, current).then((): void => {
      if (current()) { this.syncConnState(); }
    }).catch(() => {});
  }

  private releaseDesktop(hostId: string): void {
    let runtime = this.runtimes.get(hostId);
    if (!runtime) { return; }
    this.runtimes.delete(hostId);
    runtime.unobserve();
    if (runtime.refreshTimer >= 0) { clearTimeout(runtime.refreshTimer); }
    runtime.client?.cancelById(`home-accounts-${hostId}`);
    runtime.lease.release();
    this.clearLiveDesktopData(hostId, true);
    this.syncConnState();
  }

  private clearLiveDesktopData(hostId: string, removed: boolean = false): void {
    this.agentActivityWrites.forget(hostId);
    this.usageByHost = withoutDesktop(this.usageByHost, hostId);
    if (removed) {
      this.desktopMachines = withoutDesktop(this.desktopMachines, hostId);
      this.automationsByHost = withoutDesktop(this.automationsByHost, hostId);
      this.automationRunsByHost = withoutDesktop(this.automationRunsByHost, hostId);
    }
    this.setHostError('usageErrors', hostId, ''); this.setHostError('automationErrors', hostId, '');
  }

  private retainDesktop(hostId: string): HostRuntime {
    let context = getContext(this) as common.UIAbilityContext;
    let lease = retainDesktopConnection(context, hostId);
    let runtime: HostRuntime = { lease: lease, unobserve: (): void => {}, client: null, online: false,
      connecting: false, refreshTimer: -1, catalogState: 'initial', catalogPending: null, catalogRefetch: null,
      usageRevision: 0, automationPending: null, automationFetchedAt: 0 };
    this.runtimes.set(hostId, runtime);
    let epoch = this.epoch;
    let previousCredential = lease.connection.getCredentialStatus();
    runtime.unobserve = lease.connection.observe((phase: SessionPhase): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId) !== runtime) { return; }
      runtime.online = phase === 'connected';
      runtime.connecting = phase === 'connecting' || phase === 'handshaking' || phase === 'reconnecting';
      let client = lease.connection.getClient();
      if (runtime.client !== client) {
        if (runtime.refreshTimer >= 0) { clearTimeout(runtime.refreshTimer); runtime.refreshTimer = -1; }
        runtime.catalogState = 'initial'; runtime.catalogPending = null; runtime.catalogRefetch = null;
        runtime.automationPending = null; runtime.automationFetchedAt = 0;
        this.clearLiveDesktopData(hostId);
        runtime.client = client;
        if (client && runtime.online) {
          this.subscribeUsage(client, hostId, runtime, epoch);
          this.fetchDesktopStatus(client, hostId, epoch);
          if (this.visible) {
            this.fetchCatalog(client, hostId, epoch);
            this.fetchStats(client, hostId, epoch);
          }
        }
      }
      this.syncConnState();
      let credential = lease.connection.getCredentialStatus();
      let credentialChanged = credential !== previousCredential;
      previousCredential = credential;
      if (credentialChanged && !runtime.connecting) { this.syncHomeAutoConnections(); }
      if (this.visible && this.activeTab === 'automations' && this.tabDesktop(this.automationDesktopId)?.id === hostId) {
        this.refreshAutomations(hostId);
      }
    });
    return runtime;
  }

  private setHostError(target: string, hostId: string, message: string): void {
    let previous = target === 'usageErrors' ? this.usageErrors : this.automationErrors;
    let next: Record<string, string> = {};
    let keys = Object.keys(previous);
    for (let i = 0; i < keys.length; i++) { next[keys[i]] = previous[keys[i]]; }
    next[hostId] = message;
    if (target === 'usageErrors') { this.usageErrors = next; }
    else { this.automationErrors = next; }
  }

  private fetchStats(client: SpikeRpcClient, hostId: string, epoch: number): void {
    client.request('stats.summary', null, 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      let value = response instanceof RpcSuccess ? readHomeStats(response.result) : null;
      if (value) {
        this.statsByHost[hostId] = value;
        this.statsTotal = totalHomeStats(this.statsByHost, this.hosts.map((host: HostMeta): string => host.id));
      }
    }).catch(() => {});
  }

  private fetchDesktopStatus(client: SpikeRpcClient, hostId: string, epoch: number): void {
    let paired = this.runtimes.get(hostId)?.lease.connection.getPairedMeta();
    client.request('status.get', null, 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      if (paired && response instanceof RpcSuccess) {
        try {
          let value = JSON.parse(response.result) as Record<string, Object>;
          let descriptor = readHostMachineDescriptor(value);
          let machines = withoutDesktop(this.desktopMachines, hostId);
          machines[hostId] = { pairedAt: paired.lastConnected, endpoint: paired.endpoint, descriptor: descriptor };
          this.desktopMachines = machines;
          let machineName = value['machineName'];
          if (descriptor.hostPlatform || descriptor.hostMachine || (typeof machineName === 'string' && machineName.trim())) {
            updateHostMachine(getContext(this), paired, descriptor).catch(() => {});
          }
        } catch (e) {}
      }
    }).catch(() => {});
  }

  private applyUsageSnapshot(hostId: string, runtime: HostRuntime, json: string): void {
    runtime.usageRevision++;
    let rows = readHomeUsage(json);
    let next = withoutDesktop(this.usageByHost, hostId);
    if (rows !== null) { next[hostId] = rows; }
    this.usageByHost = next;
    this.setHostError('usageErrors', hostId, rows !== null ? '' : '账户用量暂不可用，可打开账户页重试。');
  }

  private subscribeUsage(client: SpikeRpcClient, hostId: string, runtime: HostRuntime, epoch: number): void {
    let id = `home-accounts-${hostId}`;
    let wire = JSON.stringify({ id: id, deviceToken: client.deviceToken, method: 'accounts.subscribe' });
    let started = client.subscribeWithId(id, wire, (json: string): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      let event = homeUsageEventType(json);
      if (event === 'snapshot') { this.applyUsageSnapshot(hostId, runtime, json); }
      if (event === 'error') {
        this.readUsage(client, hostId, runtime, epoch, false).catch(() => {});
      }
    });
    if (!started) { this.readUsage(client, hostId, runtime, epoch, false).catch(() => {}); }
  }

  private async readUsage(client: SpikeRpcClient, hostId: string, runtime: HostRuntime,
    epoch: number, refresh: boolean): Promise<void> {
    let revision = ++runtime.usageRevision;
    let result = await client.request('accounts.list', refresh ? '{"refreshUsage":true}' : '{}');
    if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client || runtime.usageRevision !== revision) { return; }
    if (result instanceof RpcSuccess) { this.applyUsageSnapshot(hostId, runtime, result.result); }
    else if (this.usageByHost[hostId] === undefined) {
      this.setHostError('usageErrors', hostId, '账户用量暂不可用，可打开账户页重试。');
    }
  }

  private async refreshUsage(hostId: string): Promise<void> {
    let runtime = this.runtimes.get(hostId);
    let client = runtime?.client;
    if (!runtime?.online || !client || this.usageRefreshing.includes(hostId)) { return; }
    this.usageRefreshing = this.usageRefreshing.concat(hostId);
    try { await this.readUsage(client, hostId, runtime, this.epoch, true); }
    finally { this.usageRefreshing = this.usageRefreshing.filter((id: string): boolean => id !== hostId); }
  }

  private fetchAutomations(client: SpikeRpcClient, hostId: string, epoch: number, afterWrite: boolean = false): Promise<void> {
    let found = this.runtimes.get(hostId);
    if (epoch !== this.epoch || !found || found.client !== client) { return Promise.resolve(); }
    let rt: HostRuntime = found;
    let pending = rt.automationPending;
    if (pending) {
      return afterWrite ? pending.then((): Promise<void> => this.fetchAutomations(client, hostId, epoch)) : pending;
    }
    rt.automationFetchedAt = Date.now();
    let request = client.request('automation.list', '{}', 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      let rows = response instanceof RpcSuccess ? readHomeAutomations(response.result) : null;
      if (response instanceof RpcSuccess && rows !== null) {
        rt.lease.connection.rememberAutomationCatalog(client, response.result);
        let next: Record<string, HomeAutomation[]> = {};
        let keys = Object.keys(this.automationsByHost);
        for (let i = 0; i < keys.length; i++) { next[keys[i]] = this.automationsByHost[keys[i]]; }
        next[hostId] = rows; this.automationsByHost = next;
        this.fetchAutomationRuns(client, hostId, epoch);
        this.setHostError('automationErrors', hostId, '');
      } else {
        this.setHostError('automationErrors', hostId, '自动化列表不可用，请打开自动化页重试。');
      }
    }).catch((): void => {}).finally((): void => {
      if (rt.automationPending === request) { rt.automationPending = null; }
    });
    rt.automationPending = request;
    return request;
  }

  private fetchAutomationRuns(client: SpikeRpcClient, hostId: string, epoch: number): void {
    client.request('automation.runs', JSON.stringify({ limit: 5, preview: true }), 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      let rows = response instanceof RpcSuccess ? readHomeAutomationRuns(response.result) : null;
      if (rows) {
        let next: Record<string, HomeAutomationRun[]> = {};
        let keys = Object.keys(this.automationRunsByHost);
        for (let i = 0; i < keys.length; i++) { next[keys[i]] = this.automationRunsByHost[keys[i]]; }
        next[hostId] = rows; this.automationRunsByHost = next;
      }
    }).catch(() => {});
  }

  async toggleAutomation(hostId: string, row: HomeAutomation, value: boolean): Promise<void> {
    let key = `${hostId}:${row.id}`;
    let rt = this.runtimes.get(hostId);
    if (!rt || !rt.online || !rt.client || this.automationBusy.includes(key)) { return; }
    let client = rt.client; let epoch = this.epoch;
    this.automationBusy = this.automationBusy.concat(key);
    let requested: Record<string, boolean> = {};
    let keys = Object.keys(this.automationRequested);
    for (let i = 0; i < keys.length; i++) { requested[keys[i]] = this.automationRequested[keys[i]]; }
    requested[key] = value; this.automationRequested = requested;
    this.setHostError('automationErrors', hostId, '');
    try {
      let response = await client.request('automation.update', homeAutomationToggleParams(row, value));
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      if (!(response instanceof RpcSuccess)) {
        this.setHostError('automationErrors', hostId, '更新未获确认；桌面可能已执行，请刷新后核对。');
      }
      await this.fetchAutomations(client, hostId, epoch, true);
    } catch (e) {
      if (epoch === this.epoch) { this.setHostError('automationErrors', hostId, '更新结果未知，请刷新后核对。'); }
    } finally {
      this.automationBusy = this.automationBusy.filter((item: string): boolean => item !== key);
      let next: Record<string, boolean> = {};
      let names = Object.keys(this.automationRequested);
      for (let i = 0; i < names.length; i++) { if (names[i] !== key) { next[names[i]] = this.automationRequested[names[i]]; } }
      this.automationRequested = next;
    }
  }

  refreshAutomations(hostId: string): void {
    let rt = this.runtimes.get(hostId);
    if (rt && rt.online && rt.client) { this.fetchAutomations(rt.client, hostId, this.epoch); }
  }

  private fetchCatalog(client: SpikeRpcClient, hostId: string, epoch: number, afterCurrent: boolean = false): Promise<void> {
    let found = this.runtimes.get(hostId);
    if ((!this.visible && !afterCurrent) || !this.appInForeground || epoch !== this.epoch || !found ||
      !found.online || found.client !== client) { return Promise.resolve(); }
    let rt: HostRuntime = found;
    if (rt.catalogPending) {
      if (!afterCurrent) { return rt.catalogPending; }
      if (!rt.catalogRefetch) {
        let refetch: Promise<void> = rt.catalogPending.then((): Promise<void> => {
          if (rt.catalogRefetch === refetch) { rt.catalogRefetch = null; }
          return this.fetchCatalog(client, hostId, epoch, true);
        });
        rt.catalogRefetch = refetch;
      }
      return rt.catalogRefetch!;
    }
    if (rt.refreshTimer >= 0) { clearTimeout(rt.refreshTimer); rt.refreshTimer = -1; }
    let request = client.request('worktree.ps', JSON.stringify({ limit: 10000 }), 8000).then((response: RpcResponse): void => {
      let rows = response instanceof RpcSuccess ? readHomeCatalog(response.result) : null;
      this.finishCatalog(client, hostId, epoch, rt, rows);
    }, (): void => this.finishCatalog(client, hostId, epoch, rt, null));
    rt.catalogPending = request;
    return request;
  }

  private finishCatalog(client: SpikeRpcClient, hostId: string, epoch: number, rt: HostRuntime, rows: HomeWorktree[] | null): void {
    if (epoch !== this.epoch || this.runtimes.get(hostId) !== rt || rt.client !== client) { return; }
    rt.catalogPending = null;
    let paired = rt.lease.connection.getPairedMeta();
    rt.catalogState = rows && paired ? 'ready' : 'unavailable';
    if (rows && paired) {
      let value: HomeWorktreeCounts = { pairedAt: paired.lastConnected, totalWorktrees: rows.length,
        activeCount: rows.filter((row: HomeWorktree): boolean => row.active).length };
      let previous = this.agentCatalogs.get(hostId)?.counts;
      let counts: WorktreeCountProof = previous && previous.value.pairedAt === value.pairedAt
        && previous.value.totalWorktrees === value.totalWorktrees && previous.value.activeCount === value.activeCount
        ? previous : { value: value, save: 'needed' };
      let entries = rows.flatMap((row: HomeWorktree): HomeAgentEntry[] => row.agents);
      this.agentCatalogs.set(hostId, { counts: counts, entries: entries, at: Date.now() });
      if (counts.save === 'needed') {
        counts.save = 'pending';
        new DeviceRowStore(getContext(this), hostId).writeHomeCounts(value).then((saved: boolean): void => {
          counts.save = saved ? 'saved' : 'needed';
        }).catch((): void => { counts.save = 'needed'; });
      }
    }
    this.rebuildRows();
    if (!this.visible || !this.appInForeground) { return; }
    if (this.activeTab === 'automations' && this.tabDesktop(this.automationDesktopId)?.id === hostId
      && Date.now() - rt.automationFetchedAt > 15000) { this.fetchAutomations(client, hostId, epoch); }
    rt.refreshTimer = setTimeout((): void => {
      rt.refreshTimer = -1;
      if (epoch === this.epoch && rt.online) { this.fetchCatalog(client, hostId, epoch); }
    }, 3000);
  }

  private refreshSummaries(): void {
    let next: Record<string, string> = {};
    this.hosts.forEach((host: HostMeta): void => {
      let catalog = this.agentCatalogs.get(host.id);
      if (!catalog) {
        if (this.runtimes.get(host.id)?.catalogState === 'unavailable') {
          next[host.id] = '工作区列表不可用';
        }
        return;
      }
      let value = catalog.counts.value;
      next[host.id] = `${value.totalWorktrees} 个工作区${value.activeCount > 0 ? ` · ${value.activeCount} 个活跃` : ''}`;
    });
    this.summaries = next;
  }

  private rebuildRows(): void {
    let desktops = this.hosts.map((host: HostMeta): AgentDesktop => {
      let snapshot = this.agentCatalogs.get(host.id);
      let runtime = this.runtimes.get(host.id);
      return {
        id: host.id, name: host.name, catalog: snapshot?.entries ?? null, seenAt: snapshot?.at ?? 0,
        connection: runtime?.online ? 'connected' : runtime?.connecting ? 'connecting' : 'disconnected',
        live: runtime?.online === true && runtime.catalogState === 'ready' && !!snapshot?.entries,
        loading: runtime?.connecting === true || (runtime?.online === true && runtime.catalogState === 'initial'),
        pendingActivity: this.agentActivityWrites.snapshot(host.id)
      };
    });
    this.agentDesktops = desktops;
    this.activeAgentRows = activeAgents(desktops);
    let needsYou = agentsNeedingYou(desktops);
    this.agentsNeedingYouCount = needsYou.length;
    let counts: Record<string, number> = {};
    needsYou.forEach((row: AgentListRow): void => { counts[row.hostId] = (counts[row.hostId] ?? 0) + 1; });
    this.needsYouByDesktop = counts;
    this.refreshSummaries();
  }

  // ---------------------------------------------------------------- actions

  openHostDetail(hostId: string): void {
    let connection = this.runtimes.get(hostId)?.lease.connection;
    let credential = connection?.getCredentialStatus();
    if (credential === 'missing') { this.openPairScan(); return; }
    if (credential === 'temporarily-unavailable') { connection?.connect(true); return; }
    this.openHostRoute(hostId, '');
  }

  openHostRoute(hostId: string, suffix: string, params: Record<string, string> = {}, hostListFirst: boolean = false): void {
    this.openShellRoute({ hostId: hostId, pathname: `/h/${encodeURIComponent(hostId)}${suffix}`, params: params }, hostListFirst);
  }

  private openShellRoute(route: ShellRoute, hostListFirst: boolean = false): void {
    router.pushUrl({ url: 'pages/ShellScreen', params: shellRouterParams(route, hostListFirst) }).catch(() => {});
  }

  private openAgent(row: AgentListRow, withPane: boolean = true): void {
    if (this.online[row.hostId] !== true) {
      let desktop = this.hosts.find((host: HostMeta): boolean => host.id === row.hostId);
      promptAction.showDialog({ title: uiText('{{desktop}} 离线', this.uiLocale).replace('{{desktop}}', desktop?.name ?? ''),
        message: uiText('重新连接后可打开此智能体。', this.uiLocale) }).catch(() => {});
      return;
    }
    let latest = this.agentCatalogs.get(row.hostId)?.entries?.find((entry: HomeAgentEntry): boolean =>
      entry.agent['paneKey'] === row.entry.agent['paneKey'] && entry.worktreeId === row.entry.worktreeId
      && entry.executionHostId === row.entry.executionHostId && entry.workspaceIdentityKey === row.entry.workspaceIdentityKey);
    if (!latest || latest.ambiguousWorkspace) {
      promptAction.showDialog({ title: uiText('无法确定工作区', this.uiLocale),
        message: uiText('无法确认此工作区属于哪台主机。', this.uiLocale) }).catch(() => {});
      return;
    }
    if (withPane && row.unread === true) { this.changeAgentActivity([row], true, false).catch(() => {}); }
    let params: Record<string, string> = { 'executionHost': row.entry.executionHost, 'name': row.entry.workspaceName };
    if (withPane) { params['paneKey'] = String(row.entry.agent['paneKey']); }
    this.openHostRoute(row.hostId, `/session/${encodeURIComponent(row.entry.worktreeId)}`, params, true);
  }

  private async writeAgentActivity(batch: AgentActivityBatch, read?: boolean): Promise<string> {
    let hostId = batch.hostId;
    let runtime = this.runtimes.get(hostId);
    let client = runtime?.client;
    if (!runtime || !runtime.online || !client) { return 'unavailable'; }
    let activeRuntime: HostRuntime = runtime;
    let activeClient: SpikeRpcClient = client;
    let epoch = this.epoch;
    return this.agentActivityWrites.write(hostId, batch.paneKeys, read, activeClient,
      (): boolean => this.epoch === epoch && this.runtimes.get(hostId) === activeRuntime
        && activeRuntime.online && activeRuntime.client === activeClient,
      (): Promise<void> => this.fetchCatalog(activeClient, hostId, epoch, true), batch.executionHost || undefined);
  }

  private async changeAgentActivity(rows: AgentListRow[], read?: boolean, report: boolean = true): Promise<void> {
    let plan = planAgentActivity(rows, read, (hostId: string): HomeAgentEntry[] => this.agentCatalogs.get(hostId)?.entries ?? []);
    let outcomes = await Promise.all(plan.batches.map(async (batch: AgentActivityBatch): Promise<string> => {
      let error = await this.writeAgentActivity(batch, read);
      if (!error) { return ''; }
      let name = this.hosts.find((host: HostMeta): boolean => host.id === batch.hostId)?.name ?? '';
      return error === 'agent_activity_needs_desktop_window' && name && !batch.executionHost
        ? uiText('无法更新。请在 {{desktop}} 上打开 Orca。', this.uiLocale).replace('{{desktop}}', name)
        : uiText('无法更新智能体列表。', this.uiLocale);
    }));
    let failure = outcomes.find((message: string): boolean => message.length > 0)
      ?? (plan.unavailable ? uiText('无法更新智能体列表。', this.uiLocale) : '');
    if (report && failure && this.visible) { promptAction.showToast({ message: failure }); }
  }

  private agentActions(row: AgentListRow): void {
    playHapticFeedback('mediumImpact').catch(() => {});
    this.agentAction = ''; this.agentActionTarget = row; this.agentSheetOpen = true;
  }

  @Builder
  private agentActionsSheet() {
    AgentActions({ row: this.agentActionTarget,
      onChoose: (action: string): void => { this.agentAction = action; this.agentSheetOpen = false; } })
  }

  private async afterAgentActions(): Promise<void> {
    let row = this.agentActionTarget;
    let action = this.agentAction;
    this.agentActionTarget = null; this.agentAction = ''; this.agentSheetOpen = false;
    if (!row || !this.visible) { return; }
    let hostId = row.hostId;
    if (!this.hosts.some((host: HostMeta): boolean => host.id === hostId)) { return; }
    if (action === 'open' || action === 'workspace') { this.openAgent(row, action === 'open'); }
    else if (action === 'read') { await this.changeAgentActivity([row], row.unread === true); }
    else if (action === 'clear') { await this.changeAgentActivity([row]); }
    else if (action === 'copy') {
      try {
        await pasteboard.getSystemPasteboard().setData(pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, row.title));
        promptAction.showToast({ message: uiText('已复制', this.uiLocale) });
      } catch (e) { promptAction.showToast({ message: uiText('无法复制标题', this.uiLocale) }); }
    }
  }

  openPairScan(): void {
    router.pushUrl({ url: 'pages/PairScan' }).catch(() => {});
  }

  openOnConnectedHost(route: string): void {
    let hosts = this.hosts.filter((host: HostMeta): boolean => this.online[host.id] === true);
    if (hosts.length === 1) {
      let hostId = hosts[0].id;
      this.openPickedDesktop({ hostId: hostId, pathname: `/h/${encodeURIComponent(hostId)}${route}`, params: {} });
    } else if (hosts.length > 1) {
      this.offeredActionHosts = hosts.map((host: HostMeta): string => host.id);
      this.showTabHostPicker(route === '/new-workspace' ? 'workspace' : 'tasks');
    }
  }

  openNewAutomation(hostId: string): void {
    if (this.online[hostId] !== true) { return; }
    let params: Record<string, string> = { 'new': '1' };
    this.openHostRoute(hostId, '/automations', params);
  }

  private desktopIsLive(id: string): boolean {
    return ['connecting', 'handshaking', 'connected', 'reconnecting'].includes(this.hostPhases[id]);
  }

  private desktopSubtitle(host: HostMeta | null): string {
    if (!host) { return ''; }
    let path = this.runtimes.get(host.id)?.lease.connection.getActivePath();
    let label = path === 'relay' ? 'Orca Relay' : uiText(path === 'tailscale' ? '直连 · Tailscale' : '直连 · 局域网', this.uiLocale);
    return this.online[host.id] === true ? `${label} · ${endpointLabel(host.endpoint)}` : endpointLabel(host.endpoint);
  }

  private openDesktopActions(host: HostMeta): void {
    let credential = this.runtimes.get(host.id)?.lease.connection.getCredentialStatus();
    if (credential === 'missing' || credential === 'temporarily-unavailable') {
      this.removeHost(host).catch(() => {}); return;
    }
    this.hostAction = ''; this.hostActionTarget = host; this.hostSheetOpen = true;
  }

  @Builder
  private desktopActionsSheet() {
    DesktopActions({ name: this.hostActionTarget?.name ?? '', subtitle: this.desktopSubtitle(this.hostActionTarget),
      live: this.desktopIsLive(this.hostActionTarget?.id ?? ''),
      reconnect: this.desktopIsLive(this.hostActionTarget?.id ?? '') && (this.hostActionTarget?.lastConnected ?? 0) > 0,
      onChoose: (action: string): void => { this.hostAction = action; this.hostSheetOpen = false; } })
  }

  private afterDesktopActions(): void {
    let id = this.hostActionTarget?.id;
    let action = this.hostAction;
    this.hostSheetOpen = false; this.hostActionTarget = null; this.hostAction = '';
    let host = this.hosts.find((item: HostMeta): boolean => item.id === id);
    if (!this.visible || !host) { return; }
    if (action === 'connect') {
      this.runtimes.get(host.id)?.lease.connection.reconnect();
    } else if (action === 'disconnect') {
      this.runtimes.get(host.id)?.lease.connection.disconnect();
      appendLog(getContext(this), LOG_LEVEL_INFO, '已断开连接', '', host.id).catch(() => {});
    } else if (action === 'diagnostics') {
      router.pushUrl({ url: 'pages/ConnectionLog', params: { 'hostId': host.id } }).catch(() => {});
    } else if (action === 'edit') {
      router.pushUrl({ url: 'pages/HostDetail', params: { 'hostId': host.id } }).catch(() => {});
    } else if (action === 'remove') { this.removeHost(host).catch(() => {}); }
  }

  async removeHost(host: HostMeta): Promise<void> {
    let answer = await promptAction.showDialog({
      title: uiText('移除主机', this.uiLocale),
      message: uiText('移除“{{name}}”？之后可以重新配对。', this.uiLocale).replace('{{name}}', host.name),
      buttons: [{ text: uiText('取消', this.uiLocale), color: this.pal().textMuted }, { text: uiText('移除', this.uiLocale), color: this.pal().statusRed }]
    });
    if (answer.index !== 1) {
      return;
    }
    try {
      let context = getContext(this) as common.Context;
      await removeDesktop(context, host.id, (): void => {
        this.loadEpoch++;
        this.hosts = this.hosts.filter((item: HostMeta): boolean => item.id !== host.id);
        this.agentCatalogs.delete(host.id);
        this.releaseDesktop(host.id);
        this.syncHomeAutoConnections();
      });
    } catch (e) {
      this.loadError = '移除失败，凭证或页面数据未能清理，请重试。';
    }
  }

  // ----------------------------------------------------------------- paint

  @Builder
  tabHeader(titleKey: string, usageHostId: string = '') {
    Row() {
      Text(uiText(titleKey, this.uiLocale))
        .fontFamily('Geist').fontSize(22)
        .fontWeight(FontWeight.Bold)
        .fontColor(this.pal().textPrimary)
        .maxLines(1)
        .layoutWeight(1)
      if (usageHostId) {
        Button({ type: ButtonType.Normal }) {
          if (this.usageRefreshing.includes(usageHostId)) {
            LoadingProgress().width(20).height(20).color(this.pal().textSecondary)
          } else {
            Image($r('app.media.lucide_refresh_cw')).supportSvg2(true).width(21).height(21)
              .colorFilter(lucideColorFilter(this.pal().textSecondary))
          }
        }.width(44).height(44).borderRadius(12).backgroundColor(Color.Transparent)
          .enabled(this.online[usageHostId] === true && !this.usageRefreshing.includes(usageHostId))
          .opacity(this.online[usageHostId] === true ? 1 : 0.4)
          .accessibilityText(uiText('刷新用量', this.uiLocale))
          .onClick(() => { this.refreshUsage(usageHostId).catch(() => {}); })
      }
    }
    .width('100%')
    .height(44)
    .padding({ left: 20, right: 12 })
    .alignItems(VerticalAlign.Center)
  }

  @Builder
  sectionHeading(heading: HomeSectionHeading) {
    Row() {
      Text(heading.title)
        .fontFamily('Geist').fontSize(15)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .maxLines(1)
      if (heading.aside.length > 0) {
        Text(heading.aside)
          .fontFamily('Geist').fontSize(13)
          .fontColor(this.pal().textMuted)
          .margin({ left: 8 })
          .alignSelf(ItemAlign.End)
      }
    }
    .width('100%')
    .alignItems(VerticalAlign.Bottom)
    .padding({ left: 4, right: 4 })
    .margin({ top: heading.first ? 4 : 20, bottom: 7 })
  }

  @Builder
  desktopRow($$: DesktopRowPresentation) {
    Row() {
      // 机器磁贴（上游 tile 30x30 圆角 10 + 角落连接点）
      Stack({ alignContent: Alignment.Center }) {
        Column()
          .width(30)
          .height(30)
          .borderRadius(10)
          .backgroundColor(this.pal().bgRaised)
        Image(this.desktopIcon($$.host)).supportSvg2(true)
          .width(17).height(17)
          .colorFilter(lucideColorFilter(this.pal().textPrimary))
        Circle({ width: 14, height: 14 })
          .fill(this.desktopDotColor($$.host.id, $$.verdict.kind))
          .stroke(this.pal().bgPanel)
          .strokeWidth(2)
          .position({ x: 21, y: 21 })
      }
      .width(30)
      .height(30)
      .margin({ top: 9, right: 11 })

      Column() {
        Text($$.host.name)
          .fontFamily('Geist').fontSize(16)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Text() {
          Span(this.hostStatusLine($$.host, $$.verdict))
            .fontColor($$.verdict.kind === 'normal' ? this.pal().textMuted : this.desktopDotColor($$.host.id, $$.verdict.kind))
          if (this.desktopMachineLine($$.host)) {
            Span(` · ${this.desktopMachineLine($$.host)}`).fontColor(this.pal().textSecondary)
          }
        }
        .fontFamily('Geist').fontSize(14).lineHeight(18)
        .maxLines(this.online[$$.host.id] === true ? 1 : 2)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
        .width('100%')
        .margin({ top: 1 })
        if ($$.verdict.kind === 'unreachable' && !$$.host.relay) {
          this.desktopStatusDetail({ detail: uiText('components.hostCard.sameNetworkOnlyHint', this.uiLocale) })
        }
        if ($$.verdict.detail) { this.desktopStatusDetail({ detail: $$.verdict.detail }); }
      }
      .alignItems(HorizontalAlign.Start)
      .padding({ top: 9, bottom: 9 })
      .layoutWeight(1)

      Row({ space: 6 }) {
        if ((this.needsYouByDesktop[$$.host.id] ?? 0) > 0) {
          Text(String(this.needsYouByDesktop[$$.host.id])).fontFamily('Geist').fontSize(12).fontWeight(FontWeight.Bold)
            .fontColor(Color.Black).backgroundColor(this.pal().statusAmber).borderRadius(10)
            .constraintSize({ minWidth: 20 }).height(20).padding({ left: 6, right: 6 }).textAlign(TextAlign.Center)
            .accessibilityText(uiText(this.needsYouByDesktop[$$.host.id] === 1
              ? '{{count}} 个需要处理（单数）' : '{{count}} 个需要处理', this.uiLocale)
              .replace('{{count}}', String(this.needsYouByDesktop[$$.host.id])))
        }
        Image($r('app.media.lucide_chevron_right')).supportSvg2(true)
          .width(16).height(16)
          .colorFilter(lucideColorFilter(this.pal().textMuted))
      }
      .padding({ left: 10, right: 14 })
      .alignSelf(ItemAlign.Center)
    }
    .width('100%')
    .padding({ left: 16 })
    .alignItems(VerticalAlign.Top)
    .onClick(() => {
      this.openHostDetail($$.host.id);
    })
    .gesture(LongPressGesture().onAction(() => {
      playHapticFeedback('mediumImpact').catch(() => {});
      this.openDesktopActions($$.host);
    }))
  }

  @Builder
  private desktopStatusDetail($$: DesktopStatusDetailPresentation) {
    Text($$.detail).fontFamily('Geist').fontSize(14).lineHeight(18).fontColor(this.pal().textMuted)
      .maxLines(3).textOverflow({ overflow: TextOverflow.Ellipsis }).margin({ top: 2 })
  }

  private desktopVerdict(host: HostMeta): DesktopConnectionVerdict {
    let phase = this.hostPhases[host.id];
    let connection = this.runtimes.get(host.id)?.lease.connection;
    let credential = connection?.getCredentialStatus();
    if (credential === 'missing') {
      return { kind: 'auth-failed', label: uiText('components.hostCard.pairingInvalid', this.uiLocale),
        detail: uiText('components.hostCard.repairHint', this.uiLocale) };
    }
    if (credential === 'temporarily-unavailable') {
      return { kind: 'warning', label: uiText('components.hostCard.pairingTemporarilyUnavailable', this.uiLocale),
        detail: uiText('components.hostCard.unlockHint', this.uiLocale) };
    }
    return describeDesktopConnection({
      state: phase === 'idle' || phase === 'stopped' || !phase ? 'disconnected' : phase,
      endpoint: host.endpoint, hostName: host.name,
      lastConnectedAt: connection?.getConnectedAt() ?? (host.lastConnected || null),
      reconnectAttempts: connection?.getReconnectAttempt() ?? 0, pendingPath: connection?.getPendingPath(),
      relayHostReachability: connection?.getRelayHostReachability(),
      nowMs: Math.max(this.homeNow, Date.now())
    }, this.uiLocale);
  }

  private desktopMachine(host: HostMeta): HostMachineDescriptor {
    let live = this.desktopMachines[host.id];
    return live?.pairedAt === host.lastConnected && live.endpoint === host.endpoint ? live.descriptor : host;
  }

  private desktopMachineLine(host: HostMeta): string {
    return hostMachineLine(this.desktopMachine(host));
  }

  private desktopIcon(host: HostMeta): Resource {
    let kind = this.desktopMachine(host).hostMachine?.kind;
    if (kind === 'laptop') { return $r('app.media.lucide_laptop'); }
    if (kind === 'server') { return $r('app.media.lucide_server'); }
    return $r('app.media.lucide_monitor');
  }

  private desktopDotColor(hostId: string, kind: string): string {
    if (this.online[hostId] === true) { return this.pal().statusGreen; }
    if (kind === 'auth-failed' || kind === 'unreachable') { return this.pal().statusRed; }
    return kind === 'warning' || this.desktopIsLive(hostId) ? this.pal().statusAmber : this.pal().textMuted;
  }

  @Builder
  hairline(indent: number) {
    Row()
      .height(0.5)
      .backgroundColor(this.pal().borderSubtle)
      .margin({ left: indent })
      .width('100%')
  }

  /** 连接行的状态文案：已连接 → worktree 概要（上游 homeHostWorktreeSummary）。 */
  hostStatusLine(host: HostMeta, verdict: DesktopConnectionVerdict): string {
    if (this.online[host.id] !== true) { return verdict.label; }
    let summary = this.summaries[host.id];
    return summary !== undefined && summary.length > 0 ? uiText(summary, this.uiLocale) : verdict.label;
  }

  @Builder
  feedTab() {
    Column() {
      if (!this.loaded || this.loadError.length > 0 || this.hosts.length > 0) {
        this.tabHeader('动态')
      }
      if (this.loadError.length > 0) {
        Text(this.loadError).fontColor(this.pal().statusRed).fontFamily('Geist').fontSize(15).padding(16)
        Button(uiText('重试', this.uiLocale)).onClick(() => this.reload())
      } else if (!this.loaded) {
        LoadingProgress().width(32).height(32)
      } else if (this.hosts.length === 0) {
        this.homeEmptyState()
      } else {
        Scroll() {
          Column() {
            if (this.activeAgentRows.length > 0) {
              Row({ space: 6 }) {
                Text() {
                  Span(uiText('home.activeAgents.heading', this.uiLocale)).fontWeight(600).fontColor(this.pal().textPrimary)
                  Span(`  ${this.activeAgentRows.length}`).fontWeight(FontWeight.Medium).fontColor(this.pal().textMuted)
                }.fontFamily('Geist').fontSize(15).maxLines(1)
                Blank()
                Text(uiText('查看所有智能体', this.uiLocale)).fontFamily('Geist').fontSize(14)
                  .fontWeight(FontWeight.Medium).fontColor(this.pal().accentBlue)
                  .accessibilityRole(AccessibilityRoleType.HYPERLINK)
                  .padding({ top: 8, bottom: 8 })
                  .onClick(() => { this.activeTab = 'agents'; })
              }.width('100%').alignItems(VerticalAlign.Bottom).padding({ left: 4, right: 4 })
                .margin({ top: 4, bottom: 7 })
              ForEach([this.activeAgentRows.slice(0, 3)], (rows: AgentListRow[]) => {
                AgentListRows({ rows: rows, desktops: this.agentDesktops,
                  nameDesktop: this.hosts.length > 1, now: this.homeNow,
                  onOpen: (row: AgentListRow): void => this.openAgent(row),
                  onActions: (row: AgentListRow): void => this.agentActions(row),
                  onRead: (items: AgentListRow[], read: boolean): void => { this.changeAgentActivity(items, read).catch(() => {}); },
                  onClear: (items: AgentListRow[]): void => { this.changeAgentActivity(items).catch(() => {}); } })
              }, (rows: AgentListRow[]): string =>
                JSON.stringify(rows.map((row: AgentListRow): string => agentRowRevision(row, agentPreview(row)))))
            }

            this.sectionHeading({ title: uiText('已配对桌面', this.uiLocale), aside: '', first: this.activeAgentRows.length === 0 })
            Column() {
              ForEach(this.hosts, (host: HostMeta, index: number) => {
                Column() {
                  if (index > 0) {
                    this.hairline(57)
                  }
                  this.desktopRow({ host: host, verdict: this.desktopVerdict(host) })
                }
                .width('100%')
              }, (host: HostMeta): string => `${host.id}:${host.name}:${host.endpoint}`)
              this.hairline(16)
              Button({ type: ButtonType.Normal }) {
                Row({ space: 10 }) {
                  Image($r('app.media.lucide_plus')).supportSvg2(true).width(18).height(18)
                    .colorFilter(lucideColorFilter(this.pal().accentBlue))
                  Text(uiText('配对一台桌面', this.uiLocale)).fontFamily('Geist').fontSize(16)
                    .fontColor(this.pal().accentBlue)
                }.width('100%').padding({ left: 16, right: 16 })
              }.width('100%').constraintSize({ minHeight: 44 }).backgroundColor(Color.Transparent)
                .accessibilityText(uiText('配对一台桌面', this.uiLocale)).onClick(() => this.openPairScan())
            }
            .width('100%')
            .borderRadius(16)
            .backgroundColor(this.pal().bgPanel)
            .clip(true)
            .margin({ bottom: 8 })
            Row() {
              Stack() {
                Image($r('app.media.lucide_list_todo')).supportSvg2(true).width(17).height(17)
                  .colorFilter(lucideColorFilter(this.pal().textPrimary))
              }.width(30).height(30).borderRadius(10).backgroundColor(this.pal().bgRaised)
                .margin({ top: 9, right: 11 })
              Column({ space: 1 }) {
                Text(uiText('任务', this.uiLocale)).fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary)
                Text(uiText('浏览问题和评审', this.uiLocale)).fontFamily('Geist').fontSize(14)
                  .fontColor(this.pal().textSecondary)
              }.alignItems(HorizontalAlign.Start).layoutWeight(1).padding({ top: 9, bottom: 9 })
              Row() {
                Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(16).height(16)
                  .colorFilter(lucideColorFilter(this.pal().textMuted))
              }.padding({ left: 10, right: 14 }).alignSelf(ItemAlign.Center)
            }.padding({ left: 16 }).alignItems(VerticalAlign.Top).width('100%')
              .borderRadius(16).backgroundColor(this.pal().bgPanel)
              .opacity(this.onlineCount() > 0 ? 1 : 0.45).enabled(this.onlineCount() > 0)
              .accessibilityGroup(true).accessibilityText(uiText('任务', this.uiLocale))
              .onClick(() => this.openOnConnectedHost('/tasks'))
              .margin({ top: 12, bottom: TAB_BAR_HEIGHT + 24 })
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

  @Builder
  stepRow(index: number, title: string, desc: string) {
    Row({ space: 14 }) {
      Text(`${index}`)
        .fontFamily('Geist').fontSize(14)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .width(26)
        .height(26)
        .borderRadius(13)
        .backgroundColor(this.pal().bgRaised)
        .textAlign(TextAlign.Center)
      Column({ space: 2 }) {
        Text(uiText(title, this.uiLocale))
          .fontFamily('Geist').fontSize(17)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
        Text(uiText(desc, this.uiLocale))
          .fontFamily('Geist').fontSize(15)
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
          Image($r('app.media.orca_mark')).supportSvg2(true)
            .width(69.17).height(44)
            .colorFilter(lucideColorFilter(this.pal().textPrimary))
            .accessibilityLevel('no')
          Text(uiText('连接桌面', this.uiLocale))
            .fontFamily('Geist').fontSize(28)
            .fontWeight(FontWeight.Bold)
            .fontColor(this.pal().textPrimary)
            .textAlign(TextAlign.Center)
            .margin({ top: 26, bottom: 10 })
          Text(uiText('与电脑上的 Orca 配对，即可在手机上查看智能体、进入任意终端并推进工作。', this.uiLocale))
            .fontFamily('Geist').fontSize(17)
            .lineHeight(24)
            .fontColor(this.pal().textSecondary)
            .textAlign(TextAlign.Center)
        }
        .width('100%')
        .padding({ left: 8, right: 8 })
        .margin({ bottom: 34 })

        Column() {
          this.stepRow(1, '打开 Orca 桌面应用', '前往“设置” → “移动端”，生成配对二维码。')
          this.hairline(56)
          this.stepRow(2, '扫描二维码', '轻点下方“配对桌面”，扫描电脑屏幕上的二维码。')
          this.hairline(56)
          this.stepRow(3, '已连接', '桌面将显示在这里。所有数据均采用端到端加密。')
        }
        .width('100%')
        .borderRadius(16)
        .backgroundColor(this.pal().bgPanel)
        .clip(true)

        Button({ type: ButtonType.Normal }) {
          Row({ space: 8 }) {
            Image($r('app.media.lucide_qr_code')).supportSvg2(true)
              .width(18).height(18)
              .colorFilter(lucideColorFilter(this.pal().onAccent))
            Text(uiText('配对桌面', this.uiLocale))
              .fontFamily('Geist').fontSize(16)
              .fontWeight(FontWeight.Medium)
              .fontColor(this.pal().onAccent)
          }
        }
        .constraintSize({ minHeight: 48 })
        .padding({ left: 22, right: 22 })
        .borderRadius(12)
        .backgroundColor(this.pal().accentBlue)
        .margin({ top: 22 })
        .accessibilityText(uiText('配对桌面', this.uiLocale))
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
      Image(icon).supportSvg2(true)
        .width(28).height(28)
        .colorFilter(lucideColorFilter(this.pal().textMuted))
      Text(uiText(title, this.uiLocale))
        .fontFamily('Geist').fontSize(17)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .margin({ top: 6 })
      Text(uiText(message, this.uiLocale))
        .fontFamily('Geist').fontSize(15)
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
  tabHostPill(host: HostMeta, tab: string) {
    Row({ space: 6 }) {
      Circle().width(7).height(7).fill(this.online[host.id] ? this.pal().statusGreen
        : this.desktopIsLive(host.id) ? this.pal().statusAmber : this.pal().textMuted)
      Text(host.name).fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary).maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis }).flexShrink(1)
      if (this.hosts.length > 1) {
        Image($r('app.media.lucide_chevron_down')).supportSvg2(true).width(14).height(14)
          .colorFilter(lucideColorFilter(this.pal().textSecondary))
      }
    }.constraintSize({ minHeight: 32, maxWidth: '100%' }).padding({ left: 12, right: 10 })
      .margin({ top: 4, bottom: 8, left: 2 }).borderRadius(20).backgroundColor(this.pal().bgPanel)
      .accessibilityGroup(true).accessibilityText(this.hosts.length > 1
        ? uiText('{{desktop}}，选择另一台桌面', this.uiLocale).replace('{{desktop}}', host.name) : host.name)
      .onClick(() => { if (this.hosts.length > 1) { this.showTabHostPicker(tab); } })
  }

  private tabPickerTitle(): string {
    if (this.tabHostPicker === 'usage') { return '选择要显示使用情况的桌面'; }
    if (this.tabHostPicker === 'automations') { return '选择要显示自动化的桌面'; }
    return this.tabHostPicker === 'workspace' ? '选择创建工作区的桌面' : 'home.listFooter.hostPickerTitle';
  }

  private pickerHosts(): HostMeta[] {
    return this.offeredActionHosts.length > 0
      ? this.hosts.filter((host: HostMeta): boolean => this.offeredActionHosts.includes(host.id)) : this.hosts;
  }

  private pickedTabHostId(): string {
    if (this.tabHostPicker === 'usage') { return this.tabDesktop(this.usageDesktopId)?.id ?? ''; }
    if (this.tabHostPicker === 'automations') { return this.tabDesktop(this.automationDesktopId)?.id ?? ''; }
    return '';
  }

  private pickerHostSubtitle(host: HostMeta): string {
    let address = endpointLabel(host.endpoint);
    let duplicate = this.pickerHosts().some((other: HostMeta): boolean =>
      other.id !== host.id && other.name === host.name && endpointLabel(other.endpoint) === address);
    return duplicate ? `${address} · ${host.id}` : address;
  }

  @Builder
  tabDesktopPicker() {
    Column() {
      Row().width(36).height(5).borderRadius(3).backgroundColor(this.pal().textMuted).opacity(0.5)
        .margin({ bottom: 16 })
      Text(uiText(this.tabPickerTitle(), this.uiLocale))
        .fontFamily('Geist').fontSize(13).fontWeight(FontWeight.Medium).fontColor(this.pal().textSecondary)
        .width('100%').padding({ left: 16, right: 16 }).margin({ bottom: 8 })
      List() {
        ForEach(this.pickerHosts(), (host: HostMeta, index: number) => {
          ListItem() {
            Column() {
              if (index > 0) { this.hairline(16) }
              Button({ type: ButtonType.Normal }) {
                Row({ space: 12 }) {
                  Column({ space: 3 }) {
                    Text(host.name).fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary).maxLines(1)
                    Text(this.pickerHostSubtitle(host)).fontFamily('Geist').fontSize(13)
                      .fontColor(this.pal().textSecondary).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
                  }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                  if (this.pickedTabHostId() === host.id) {
                    Image($r('app.media.lucide_check')).supportSvg2(true).width(18).height(18)
                      .colorFilter(lucideColorFilter(this.pal().accentBlue))
                  }
                }.width('100%').padding({ left: 16, right: 16 })
              }.width('100%').height(56).backgroundColor(Color.Transparent)
                .enabled(this.tabHostPicker === 'workspace' || this.offeredActionHosts.length === 0 || this.online[host.id] === true)
                .onClick(() => this.pickTabDesktop(host.id))
            }.width('100%')
          }
        }, (host: HostMeta): string => host.id)
      }.height(Math.min(this.pickerHosts().length, 4) * 56.5).width('100%').borderRadius(16)
        .clip(true).backgroundColor(this.pal().sheetGroup).scrollBar(BarState.Auto)
    }.width('100%').padding({ left: 16, right: 16, top: 8, bottom: 20 })
  }

  private usageMeterColor(used: number): string {
    return used >= 80 ? this.pal().statusRed : used >= 60 ? this.pal().statusAmber : this.pal().statusGreen;
  }

  private usageMeterLabelWidth(locale: string): number {
    let context = this.getUIContext();
    let measure = context.getMeasureUtils();
    let session = measure.measureText({ textContent: uiText('5 小时', locale), fontFamily: 'Geist', fontSize: USAGE_METER_FONT_SIZE });
    let weekly = measure.measureText({ textContent: uiText('7 天', locale), fontFamily: 'Geist', fontSize: USAGE_METER_FONT_SIZE });
    return Math.max(USAGE_METER_LABEL_MIN_WIDTH, Math.ceil(context.px2vp(Math.max(session, weekly))));
  }

  @Builder
  usageMeter(labelKey: string, window: HomeUsageWindow | undefined, fetching: boolean) {
    Row({ space: USAGE_METER_GAP }) {
      Text(uiText(labelKey, this.uiLocale)).width(this.usageMeterLabelWidth(this.uiLocale))
        .fontFamily('Geist').fontSize(USAGE_METER_FONT_SIZE)
        .fontColor(this.pal().textSecondary).maxLines(1)
      Progress({ value: Math.round(window?.usedPercent ?? 0), total: 100, type: ProgressType.Linear })
        .style({ strokeWidth: 6 }).color(this.usageMeterColor(Math.round(window?.usedPercent ?? 0)))
        .backgroundColor(this.pal().translucentFill).layoutWeight(1)
      if (!window && fetching) {
        Row() { LoadingProgress().width(15).height(15).color(this.pal().textSecondary) }
          .width(40).justifyContent(FlexAlign.End)
      } else {
        Text(window ? `${Math.round(window.usedPercent)}%` : '—').width(40)
          .textAlign(TextAlign.End).fontFamily('Geist').fontSize(13).fontColor(this.pal().textPrimary)
      }
    }.width('100%').margin({ top: 6 })
    if (window && window.resetsAt > 0) {
      Text(homeUsageResetCountdown(window.resetsAt, this.homeNow))
        .fontFamily('Geist').fontSize(12).fontColor(this.pal().textMuted)
        .margin({ left: this.usageMeterLabelWidth(this.uiLocale) + USAGE_METER_GAP, top: 2 }).maxLines(1)
    }
  }

  @Builder
  usageCard(host: HostMeta, card: HomeUsageCard, separated: boolean) {
    if (separated) { this.hairline(16) }
    Column() {
      Row({ space: USAGE_METER_GAP }) {
        Row() {
          if (card.provider === 'claude') {
            Image($r('app.media.agent_claude')).supportSvg2(true).width(16).height(16)
          } else {
            Image($r('app.media.agent_codex')).supportSvg2(true).width(16).height(16)
              .colorFilter(lucideColorFilter(this.pal().textPrimary))
          }
        }.width(28).height(28).borderRadius(8).backgroundColor(this.pal().bgRaised).justifyContent(FlexAlign.Center)
        Column({ space: 1 }) {
          Text(card.account || uiText('系统默认', this.uiLocale)).fontFamily('Geist').fontSize(16)
            .fontColor(this.pal().textPrimary).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
          if (card.subtitle || !card.account) {
            Text(card.account ? card.subtitle : uiText('使用智能体自己的登录', this.uiLocale))
              .fontFamily('Geist').fontSize(13).fontColor(this.pal().textSecondary).maxLines(1)
          }
        }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        if (card.active) {
          Text(uiText('使用中', this.uiLocale)).fontFamily('Geist').fontSize(12).fontColor(this.pal().accentBlue)
            .backgroundColor(this.pal().skillTokenSurface).borderRadius(20).padding({ left: 8, right: 8, top: 2, bottom: 2 })
        }
      }.width('100%').margin({ bottom: 4 })
      if (card.metered) {
        this.usageMeter('5 小时', card.windows.find((window: HomeUsageWindow): boolean => window.label === '会话'), card.fetching)
        this.usageMeter('7 天', card.windows.find((window: HomeUsageWindow): boolean => window.label === '每周'), card.fetching)
      }
    }.alignItems(HorizontalAlign.Start).width('100%').padding({ left: 16, right: 16, top: 14, bottom: 14 })
      .onClick(() => this.openHostRoute(host.id, '/accounts'))
  }

  private displayDate(timestamp: number, timezone: string = ''): string {
    if (!timestamp) { return uiText('未报告', this.uiLocale); }
    try {
      return new Date(timestamp).toLocaleString(this.uiLocale, { timeZone: timezone || undefined,
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch (e) { return new Date(timestamp).toLocaleString(); }
  }

  formatAgentTime(milliseconds: number, locale: string = ''): string {
    let minutes = Math.max(0, Math.floor(milliseconds / 60000));
    let hours = Math.floor(minutes / 60); let days = Math.floor(hours / 24);
    let unit = days > 0 ? 'days' : hours > 0 ? 'hours' : 'minutes';
    let value = days > 0 ? days : hours > 0 ? hours : minutes;
    return locale ? uiText(`home.stats.${unit}`, locale).replace(`{{${unit}}}`, String(value)) : `${value}${unit[0]}`;
  }

  @Builder
  statsCell(value: number, label: string, agentTime: boolean = false) {
    Column({ space: 2 }) {
      Text(agentTime ? this.formatAgentTime(value, this.uiLocale) : value.toLocaleString(this.uiLocale))
        .fontFamily('Geist').fontSize(20).fontWeight(FontWeight.Medium).fontColor(this.pal().textPrimary).maxLines(1)
      Text(uiText(label, this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.pal().textSecondary).maxLines(2).textAlign(TextAlign.Center)
    }.layoutWeight(1).padding({ top: 13, bottom: 12, left: 8, right: 8 })
  }

  @Builder
  statsSummary() {
    if (this.statsTotal !== null) {
      this.sectionHeading({ title: uiText('你的统计', this.uiLocale), aside: '', first: true })
      Row() {
        this.statsCell(this.statsTotal!.totalAgentsSpawned, '已启动智能体')
        this.statsCell(this.statsTotal!.totalAgentTimeMs, 'home.stats.agentTime', true)
        this.statsCell(this.statsTotal!.totalPRsCreated, '已创建 PR')
      }.width('100%').borderRadius(16).backgroundColor(this.pal().bgPanel).margin({ bottom: 12 })
    }
  }

  @Builder
  usageSection(host: HostMeta, provider: string) {
    if (this.usageCards(host.id, provider).length > 0) {
      this.sectionHeading({ title: provider === 'claude' ? 'Claude Code' : 'Codex',
        aside: this.usageUpdatedAt(host.id, provider), first: !this.statsTotal
        && (provider === 'claude' || this.usageCards(host.id, 'claude').length === 0) })
      Column() {
        ForEach(this.usageCards(host.id, provider), (card: HomeUsageCard, index: number) => {
          this.usageCard(host, card, index > 0)
        }, (card: HomeUsageCard): string => `${host.id}:${JSON.stringify(card)}`)
      }.width('100%').borderRadius(16).clip(true).backgroundColor(this.pal().bgPanel)
    }
  }

  private usageCards(hostId: string, provider: string): HomeUsageCard[] {
    return (this.usageByHost[hostId] ?? []).filter((card: HomeUsageCard): boolean => card.provider === provider);
  }

  private usageUpdatedAt(hostId: string, provider: string): string {
    let time = this.usageCards(hostId, provider)[0]?.updatedAt ?? 0;
    if (time <= 0) { return ''; }
    if (this.homeNow - time < 60000) { return uiText('home.usage.updatedJustNow', this.uiLocale); }
    let ago = agentTimeAgo(time, this.homeNow, this.uiLocale);
    return uiText('home.usage.updatedAgo', this.uiLocale).replace('{{time}}', ago);
  }

  @Builder
  usageTab(host: HostMeta | null) {
    Column() {
      this.tabHeader('使用情况', host?.id ?? '')
      Scroll() {
        Column() {
          if (host) { this.tabHostPill(host, 'usage') }
          this.statsSummary()
          if (!host) {
            this.tabEmptyState($r('app.media.lucide_gauge'), '暂无使用情况', '请先配对桌面，才能查看智能体账户使用情况。')
          } else if (this.online[host.id] !== true) {
            this.tabEmptyState($r('app.media.lucide_gauge'), '暂无使用情况',
              uiText('连接 {{desktop}} 后查看智能体账户用量。', this.uiLocale).replace('{{desktop}}', host.name))
          } else {
            if (this.usageByHost[host.id]?.length > 0) {
              this.usageSection(host, 'claude')
              this.usageSection(host, 'codex')
            } else if ((this.usageErrors[host.id] ?? '').length === 0) {
              if (this.usageByHost[host.id] !== undefined) {
                this.tabEmptyState($r('app.media.lucide_gauge'), '暂无使用情况', '在桌面设置 → 账户中添加账户。')
              } else {
                LoadingProgress().width(24).height(24).color(this.pal().textSecondary).margin({ top: 60 })
              }
            }
            if ((this.usageErrors[host.id] ?? '').length > 0) {
              Text(uiText(this.usageErrors[host.id], this.uiLocale)).fontFamily('Geist').fontSize(14)
                .fontColor(this.pal().textSecondary).padding(16)
              Button(uiText('管理账户', this.uiLocale)).backgroundColor(Color.Transparent).fontColor(this.pal().accentBlue)
                .onClick(() => this.openHostRoute(host.id, '/accounts'))
            }
          }
        }.width('100%').alignItems(HorizontalAlign.Start).padding({ left: 16, right: 16, bottom: 24 })
      }.scrollBar(BarState.Off).width('100%').layoutWeight(1).align(Alignment.Top)
    }.width('100%').height('100%')
  }

  private automationStatus(status: string): string {
    switch (status) {
      case 'pending': return uiText('待运行', this.uiLocale);
      case 'dispatching': return uiText('正在启动', this.uiLocale);
      case 'dispatched': return uiText('已分派', this.uiLocale);
      case 'completed': return uiText('已完成', this.uiLocale);
      case 'dispatch_failed': return uiText('无法启动', this.uiLocale);
      case 'skipped_precheck': return uiText('已跳过 · 预检查', this.uiLocale);
      case 'skipped_missed': return uiText('已跳过 · 错过计划', this.uiLocale);
      case 'skipped_unavailable': return uiText('已跳过 · 主机不可用', this.uiLocale);
      case 'skipped_needs_interactive_auth': return uiText('已跳过 · 需要登录', this.uiLocale);
      default: return uiText('未知结果', this.uiLocale);
    }
  }

  @Builder
  automationRow(host: HostMeta, row: HomeAutomation, separated: boolean) {
    if (separated) { this.hairline(0) }
    Row({ space: 12 }) {
      Column({ space: 3 }) {
        Text(row.name).fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary).maxLines(1)
        Text(homeAutomationSchedule(row, this.uiLocale))
          .fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary).maxLines(1)
        Text(row.enabled ? uiText('下次：{{date}}', this.uiLocale).replace('{{date}}', this.displayDate(row.nextRunAt, row.timezone))
          : uiText('没有下次计划运行', this.uiLocale))
          .fontFamily('Geist').fontSize(12).fontColor(this.pal().textMuted).maxLines(1)
        if (row.lastRunStatus || !row.enabled) {
          Text(row.lastRunStatus ? uiText('上次：{{status}}', this.uiLocale).replace('{{status}}', this.automationStatus(row.lastRunStatus))
            + (row.lastRunAt > 0 ? ` · ${this.displayDate(row.lastRunAt, row.timezone)}` : '') : uiText('已暂停', this.uiLocale))
            .fontFamily('Geist').fontSize(12).fontColor(this.pal().textMuted).maxLines(1)
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
        .accessibilityRole(AccessibilityRoleType.BUTTON)
        .onClick(() => this.openHostRoute(host.id, '/automations'))
      Toggle({ type: ToggleType.Switch, isOn: this.automationRequested[`${host.id}:${row.id}`] ?? row.enabled })
        .enabled(this.online[host.id] === true && !this.automationBusy.includes(`${host.id}:${row.id}`))
        .accessibilityText(uiText('按计划运行 {{name}}', this.uiLocale).replace('{{name}}', row.name))
        .onChange((value: boolean) => {
          if (value !== (this.automationRequested[`${host.id}:${row.id}`] ?? row.enabled)) {
            this.toggleAutomation(host.id, row, value).catch(() => {});
          }
        })
    }.padding(16).width('100%')
  }

  @Builder
  automationRunRow(host: HostMeta, run: HomeAutomationRun, separated: boolean) {
    if (separated) { this.hairline(16) }
    Row({ space: 10 }) {
      Stack() {
        if (['pending', 'dispatching', 'dispatched'].includes(run.status)) {
          LoadingProgress().width(12).height(12).color(this.pal().statusAmber)
        } else {
          Circle().width(7).height(7).fill(run.status === 'completed' ? this.pal().statusGreen
            : run.status === 'dispatch_failed' ? this.pal().statusRed : this.pal().textMuted)
        }
      }.width(12).height(12).accessibilityLevel('no')
      Column({ space: 3 }) {
        Text(run.title).fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary).maxLines(1)
        Text(this.automationStatus(run.status) + (run.error ? ` · ${run.error}` : '')).fontFamily('Geist')
          .fontSize(14).fontColor(this.pal().textSecondary).maxLines(2)
      }.alignItems(HorizontalAlign.Start).layoutWeight(1)
      Text(agentTimeAgo(run.createdAt, this.homeNow, this.uiLocale)).fontFamily('Geist').fontSize(15)
        .fontColor(this.pal().textMuted)
      Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(16).height(16)
        .colorFilter(lucideColorFilter(this.pal().textMuted))
    }.width('100%').padding(16).accessibilityRole(AccessibilityRoleType.BUTTON)
      .onClick(() => this.openHostRoute(host.id, '/automations'))
  }

  @Builder
  automationsTab(host: HostMeta | null) {
    Column() {
      this.tabHeader('自动化')
      Scroll() {
        Column() {
          if (!host) {
            this.tabEmptyState($r('app.media.lucide_calendar_clock'), '安排智能体工作', '请先配对桌面，才能查看和运行自动化。')
          } else {
            this.tabHostPill(host, 'automations')
            if (this.automationsByHost[host.id] === undefined) {
              if ((this.automationErrors[host.id] ?? '').length > 0) {
                this.tabEmptyState($r('app.media.lucide_calendar_clock'), '安排智能体工作', this.automationErrors[host.id])
              } else if (this.online[host.id] !== true) {
                this.tabEmptyState($r('app.media.lucide_calendar_clock'), '安排智能体工作',
                  uiText('连接 {{desktop}} 后查看和运行自动化。', this.uiLocale).replace('{{desktop}}', host.name))
              } else {
                LoadingProgress().width(24).height(24).color(this.pal().textSecondary).margin({ top: 60 })
              }
            } else if (this.automationsByHost[host.id].length === 0) {
              this.tabEmptyState($r('app.media.lucide_calendar_clock'), '暂无自动化',
                this.online[host.id] === true ? '轻点 + 为智能体安排任务。' : '')
            } else {
              this.sectionHeading({ title: uiText('已排期', this.uiLocale), aside: String(this.automationsByHost[host.id].length), first: false })
              Column() {
                ForEach(this.automationsByHost[host.id], (row: HomeAutomation, index: number) => {
                  this.automationRow(host, row, index > 0)
                }, (row: HomeAutomation): string => `${host.id}:${JSON.stringify(row)}`)
              }.width('100%').borderRadius(16).clip(true).backgroundColor(this.pal().bgPanel)
              if (this.automationRunsByHost[host.id]?.length > 0) {
                this.sectionHeading({ title: uiText('最近运行', this.uiLocale), aside: '', first: false })
                Column() {
                  ForEach(this.automationRunsByHost[host.id], (run: HomeAutomationRun, index: number) => {
                    this.automationRunRow(host, run, index > 0)
                  }, (run: HomeAutomationRun): string => `${host.id}:${JSON.stringify(run)}`)
                }.width('100%').borderRadius(16).clip(true).backgroundColor(this.pal().bgPanel)
              }
              if ((this.automationErrors[host.id] ?? '').length > 0) {
                Text(uiText(this.automationErrors[host.id], this.uiLocale)).fontFamily('Geist').fontSize(14)
                  .fontColor(this.pal().textSecondary).padding(16)
              }
            }
          }
        }.width('100%').alignItems(HorizontalAlign.Start)
          .padding({ left: 16, right: 16, bottom: host && this.online[host.id] ? 88 : 24 })
      }.scrollBar(BarState.Off).width('100%').layoutWeight(1).align(Alignment.Top)
    }.width('100%').height('100%')
  }

  @Builder
  settingsGroup(items: SettingsMenuItem[], external: boolean) {
    Column() {
      ForEach(items, (row: SettingsMenuItem, index: number) => {
        Column() {
          if (index > 0) {
            Divider().strokeWidth(0.5).color(this.pal().borderSubtle).margin({ left: 52 })
          }
          Button({ type: ButtonType.Normal }) {
            Row({ space: 12 }) {
              Row() {
                Image(row.icon).supportSvg2(true).width(18).height(18)
                  .colorFilter(lucideColorFilter(this.pal().textSecondary)).accessibilityLevel('no')
              }.width(24).justifyContent(FlexAlign.Center)
              Text(uiText(row.label, this.uiLocale)).fontFamily('Geist').fontSize(15)
                .fontColor(this.pal().textPrimary).maxLines(1).layoutWeight(1)
              if (!external) {
                Image($r('app.media.lucide_chevron_right')).supportSvg2(true).width(15).height(15)
                  .colorFilter(lucideColorFilter(this.pal().textMuted)).accessibilityLevel('no')
              }
            }.width('100%').padding({ top: 8, bottom: 8, left: 16, right: 16 })
          }.width('100%').constraintSize({ minHeight: 48 }).padding(0).borderRadius(0).backgroundColor(Color.Transparent)
          .accessibilityText(uiText(row.label, this.uiLocale))
          .onClick(() => {
            if (external) {
              let context = getContext(this) as common.UIAbilityContext;
              context.startAbility({ action: 'ohos.want.action.viewData', uri: row.target }).catch(() => {});
            } else {
              router.pushUrl({ url: row.target }).catch(() => {});
            }
          })
        }
        .width('100%')
      }, (row: SettingsMenuItem, index: number) => `${index}-${row.target}`)
    }
    .width('100%')
    .borderRadius(16)
    .backgroundColor(this.pal().sheetGroup)
    .clip(true)
  }

  @Builder
  settingsTab() {
    Column() {
      this.tabHeader('设置')
      Scroll() {
        Column({ space: 16 }) {
          this.settingsGroup(SETTINGS_MENU_ITEMS, false)
          if (this.installedVersion !== '' && this.installedVersion !== 'unknown') {
            Row() {
              Text(uiText('settings.appUpdateSettingsRows.installedVersion', this.uiLocale)
                .replace('{{version}}', this.installedVersion)).fontFamily('Geist').fontSize(15)
                .fontColor(this.pal().textPrimary)
            }.width('100%').constraintSize({ minHeight: 48 }).padding({ top: 8, bottom: 8, left: 16, right: 16 })
              .borderRadius(16).backgroundColor(this.pal().sheetGroup)
          }
          PendingCredentialCleanupCard()
          this.settingsGroup(SETTINGS_LINK_ITEMS, true)
        }
        .width('100%')
        .padding({ top: 8, left: 16, right: 16, bottom: TAB_BAR_HEIGHT + 24 })
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
            Image(tab.icon).supportSvg2(true)
              .width(25).height(25)
              .colorFilter(lucideColorFilter(this.activeTab === tab.id ? this.pal().textPrimary : this.pal().textMuted))
            if (tab.id === 'agents' && this.agentsNeedingYouCount > 0) {
              Text(this.agentsNeedingYouCount > 99 ? '99+' : String(this.agentsNeedingYouCount))
                .fontFamily('Geist').fontSize(11)
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
          Text(uiText(tab.label, this.uiLocale))
            .fontFamily('Geist').fontSize(10.5)
            .fontWeight(FontWeight.Medium)
            .fontColor(this.activeTab === tab.id ? this.pal().textPrimary : this.pal().textMuted)
            .maxLines(1)
        }
        .layoutWeight(1)
        .justifyContent(FlexAlign.Center)
        .padding({ top: 2 })
        .accessibilityGroup(true)
        .accessibilitySelected(this.activeTab === tab.id)
        .accessibilityText(tab.id === 'agents' && this.agentsNeedingYouCount > 0
          ? `${uiText(tab.label, this.uiLocale)}, ${this.agentsNeedingYouCount}` : uiText(tab.label, this.uiLocale))
        .onClick(() => {
          this.activeTab = tab.id;
          this.updateTabClock();
          if (tab.id === 'automations') { this.refreshAutomations(this.tabDesktop(this.automationDesktopId)?.id ?? ''); }
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
        Text(uiText('连接桌面以创建工作区', this.uiLocale))
          .fontFamily('Geist').fontSize(13)
          .fontColor(this.pal().textSecondary)
          .backgroundColor(this.pal().bgRaised)
          .padding({ left: 10, right: 10, top: 5, bottom: 5 })
          .borderRadius(999)
          .constraintSize({ maxWidth: 220 })
      }
      Button({ type: ButtonType.Normal }) {
        Stack() {
          Column()
            .width(FAB_SIZE)
            .height(FAB_SIZE)
            .borderRadius(28)
            .backgroundColor(this.pal().accentBlue)
            .shadow({ radius: 10, color: 'rgba(0,0,0,0.3)', offsetY: 5 })
            .opacity(this.fabDisabled() ? 0.4 : 1)
          Image($r('app.media.lucide_plus')).supportSvg2(true)
            .width(26).height(26)
            .colorFilter(lucideColorFilter(this.pal().onAccent))
            .opacity(this.fabDisabled() ? 0.4 : 1)
        }
      }
      .width(FAB_SIZE)
      .height(FAB_SIZE)
      .padding(0)
      .borderRadius(28)
      .backgroundColor(Color.Transparent)
      .enabled(!this.fabDisabled())
      .accessibilityText(uiText(this.activeTab === 'automations' ? '新建自动化' : '新建工作区', this.uiLocale))
      .onClick(() => {
        if (this.activeTab === 'automations') {
          this.openNewAutomation(this.tabDesktop(this.automationDesktopId)?.id ?? '');
        } else if (!this.fabDisabled()) {
          this.openOnConnectedHost('/new-workspace');
        }
      })
    }
    .alignItems(HorizontalAlign.End)
    .margin({ right: 18, bottom: 16 })
  }

  fabDisabled(): boolean {
    return this.hosts.length === 0 || this.onlineCount() === 0;
  }

  @Builder
  private homeContents() {
    Column() {
      Stack({ alignContent: Alignment.BottomEnd }) {
        Column() {
          Stack() {
            Column() { this.feedTab() }.width('100%').height('100%')
              .visibility(this.activeTab === 'feed' ? Visibility.Visible : Visibility.Hidden)
            Column() {
              AgentsTab({ desktops: this.agentDesktops, loaded: this.loaded, now: this.homeNow,
                onOpen: (row: AgentListRow): void => this.openAgent(row),
                onActions: (row: AgentListRow): void => this.agentActions(row),
                onRead: (rows: AgentListRow[], read: boolean): void => { this.changeAgentActivity(rows, read).catch(() => {}); },
                onClear: (rows: AgentListRow[]): void => { this.changeAgentActivity(rows).catch(() => {}); } })
            }.width('100%').height('100%').visibility(this.activeTab === 'agents' ? Visibility.Visible : Visibility.Hidden)
            Column() {
              if (this.hosts.length === 0) { this.usageTab(null) }
              else {
                ForEach(this.tabDesktopRow(this.usageDesktopId), (host: HostMeta) => { this.usageTab(host) },
                  (host: HostMeta): string => `${host.id}:${host.name}`)
              }
            }.width('100%').height('100%')
              .visibility(this.activeTab === 'usage' ? Visibility.Visible : Visibility.Hidden)
            Column() {
              if (this.hosts.length === 0) { this.automationsTab(null) }
              else {
                ForEach(this.tabDesktopRow(this.automationDesktopId), (host: HostMeta) => { this.automationsTab(host) },
                  (host: HostMeta): string => `${host.id}:${host.name}`)
              }
            }.width('100%').height('100%')
              .visibility(this.activeTab === 'automations' ? Visibility.Visible : Visibility.Hidden)
            Column() { this.settingsTab() }.width('100%').height('100%')
              .visibility(this.activeTab === 'settings' ? Visibility.Visible : Visibility.Hidden)
          }.width('100%').height('100%')
        }
        .width('100%')
        .height('100%')

        if (this.loaded && (this.activeTab === 'feed' && this.hosts.length > 0
          || this.activeTab === 'automations' && this.online[this.tabDesktop(this.automationDesktopId)?.id ?? ''] === true)) {
          this.fab()
        }
      }
      .width('100%')
      .layoutWeight(1)
      .bindSheet(this.tabHostPickerOpen, this.tabDesktopPicker, { height: SheetSize.FIT_CONTENT,
        backgroundColor: this.themeSheet, maskColor: 'rgba(0,0,0,0.55)', showClose: false, dragBar: false,
        onDisappear: (): void => this.finishTabHostPicker() })

      this.tabBar()
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.pal().bgBase)
    .accessibilityLevel(this.workspaceDrawer ? 'no-hide-descendants' : 'auto')
    .hitTestBehavior(this.workspaceDrawer ? HitTestMode.None : HitTestMode.Default)
    .bindSheet(this.hostSheetOpen, this.desktopActionsSheet, { height: SheetSize.FIT_CONTENT,
      backgroundColor: this.pal().bgBase, showClose: false, onDisappear: (): void => this.afterDesktopActions() })
  }

  @Builder
  private workspaceOverlay(request: ShellRoute, owner: number) {
    ShellSurface({ request: request, asDrawer: true, visible: this.workspacePageVisible, back: this.workspaceBack,
      onOverlayClose: (): void => { this.closeWorkspaceDrawer(owner); },
      onOverlayNavigate: (route: ShellRoute): void => {
        if (request.hostId === route.hostId && this.closeWorkspaceDrawer(owner)) { this.openShellRoute(route); }
      } })
  }

  build() {
    Stack() {
      this.homeContents()
      if (this.workspaceDrawer) {
        this.workspaceOverlay(this.workspaceDrawer!, this.workspaceDrawerOwner)
      }
    }.width('100%').height('100%')
      .bindSheet(this.agentSheetOpen, this.agentActionsSheet, { height: SheetSize.FIT_CONTENT,
        backgroundColor: this.themeSheet, maskColor: 'rgba(0,0,0,0.55)', showClose: false,
        onDisappear: (): void => { this.afterAgentActions().catch(() => {}); } })
  }
}
