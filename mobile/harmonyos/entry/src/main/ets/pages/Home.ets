import { lucideColorFilter } from '../settings/LucideColor';
import { uiText } from '../settings/NativeUi';
import { router, promptAction } from '@kit.ArkUI';
import { common } from '@kit.AbilityKit';
import { AgentWatch } from '../notifications/AgentWatch';
import { LocalNotifier, DesktopNotification } from '../notifications/LocalNotifier';
import { getBool, KEY_NOTIFICATIONS_LOCAL_ENABLED } from '../settings/SettingsStore';
import { parseLaunchRoute } from '../navigation/LaunchRoute';
import { getNumber, KEY_HOME_FONT_SCALE } from '../settings/SettingsStore';
import { deletePageStorage } from '../storage/PageStorageStore';
import { listHosts, deleteHost, getDeviceToken, getRelayCredential, HostMeta } from '../storage/HostStore';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { HostSession, SessionPhase } from '../transport/HostSession';
import { HomeWorktree, readHomeCatalog, isHomeAttention, homeAttentionRank } from '../home/HomeCatalog';
import { HomeUsageCard, HomeUsageWindow, HomeAutomation, HomeAutomationRun, readHomeUsage, readHomeAutomations,
  readHomeAutomationRuns, homeAutomationToggleParams } from '../home/HomeAccountUsage';
import { SETTINGS_MENU_ITEMS, SettingsMenuItem } from '../settings/SettingsMenu';
import { loadMobileOnboardingSteps } from '../onboarding/MobileOnboardingPlan';
import { recoverRelayPairings } from '../transport/RelayPairing';
import { HomeResume, readHomeResume, saveHomeResume, clearHomeResume } from '../home/HomeResume';
import { HomeStats, readHomeStats, totalHomeStats } from '../home/HomeStats';
import { HomeQuotaOffer, HomeQuotaScope, readHomeQuotaOffer, consumeHomeQuotaReset } from '../home/HomeQuotaReset';

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
  state: string;
  unread: boolean;
  lastOutputAt: number;
  paneKey: string;
  executionHost: string;
  lastOpened: boolean;
  actionable: boolean;
}

interface HostRuntime {
  session: HostSession;
  client: SpikeRpcClient | null;
  online: boolean;
  connecting: boolean;
  refreshTimer: number;
  catalogPending: boolean;
  automationPending: boolean;
  automationFetchedAt: number;
  watch: AgentWatch | null;
}

const TAB_SPECS: TabSpec[] = [
  { id: 'feed', label: '动态', icon: $r('app.media.lucide_list') },
  { id: 'usage', label: '使用情况', icon: $r('app.media.lucide_gauge') },
  { id: 'automations', label: '自动化', icon: $r('app.media.lucide_calendar_clock') },
  { id: 'settings', label: '设置', icon: $r('app.media.lucide_settings') }
];

const FAB_SIZE = 56;
const TAB_BAR_HEIGHT = 64; // paddingTop 6 + 图标 26 + 文本 + paddingBottom 8（上游 52 + inset）

@Entry
@Component
struct Home {
  @StorageProp('uiLocale') uiLocale: string = 'en';
  @StorageProp('themeScheme') scheme: string = 'dark';
  @State activeTab: string = 'feed';
  @State hosts: HostMeta[] = [];
  @State loaded: boolean = false;
  @State fontScale: number = 1;
  @State online: Record<string, boolean> = {};
  @State connecting: boolean = false;
  @State agentRows: JumpRow[] = [];
  @State summaries: Record<string, string> = {};
  @State loadError: string = '';
  @State agentsExpanded: boolean = false;
  @State choosingHost: boolean = false;
  @State resume: HomeResume | null = null;
  @State usageByHost: Record<string, HomeUsageCard[]> = {};
  @State automationsByHost: Record<string, HomeAutomation[]> = {};
  @State usageErrors: Record<string, string> = {};
  @State automationErrors: Record<string, string> = {};
  @State automationRunsByHost: Record<string, HomeAutomationRun[]> = {};
  @State quotaOffers: Record<string, HomeQuotaOffer> = {};
  @State quotaAllowed: Record<string, boolean> = {};
  @State quotaBusy: string[] = [];
  @State statsTotal: HomeStats | null = null;
  private statsByHost: Record<string, HomeStats> = {};
  private notifier: LocalNotifier = new LocalNotifier();
  @State automationBusy: string[] = [];
  @State automationRequested: Record<string, boolean> = {};
  private runtimes: Map<string, HostRuntime> = new Map();
  private accByHost: Map<string, HomeWorktree[]> = new Map();
  private epoch: number = 0;
  private visible: boolean = false;
  private loadEpoch: number = 0;
  private onboardingChecked: boolean = false;
  private onboardingPending: boolean = false;
  private onboardingNavigating: boolean = false;

  // ---------------------------------------------------------------- helpers

  pal(): HomePalette {
    return this.scheme === 'light' ? PALETTE_LIGHT : PALETTE_DARK;
  }



  onPageShow(): void {
    this.visible = true;
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
    getNumber(getContext(this) as common.Context, KEY_HOME_FONT_SCALE).then((v: number): void => {
      this.fontScale = Math.max(0.8, Math.min(1.5, v));
    }).catch(() => {});
  }

  onPageHide(): void {
    this.visible = false;
    this.loadEpoch++;
    this.stopProbes();
  }

  aboutToDisappear(): void {
    this.visible = false;
    this.loadEpoch++;
    this.stopProbes();
  }

  onBackPress(): boolean {
    if (this.choosingHost) { this.choosingHost = false; return true; }
    if (this.activeTab !== 'feed') { this.activeTab = 'feed'; return true; }
    return false;
  }

  reload(): void {
    let loadEpoch = ++this.loadEpoch;
    let context = getContext(this) as common.Context;
    this.resume = readHomeResume(context);
    recoverRelayPairings(context).then(() => listHosts(context)).then((hosts: HostMeta[]): void => {
      if (!this.visible || loadEpoch !== this.loadEpoch) { return; }
      this.hosts = hosts;
      this.statsTotal = totalHomeStats(this.statsByHost, hosts.map((host: HostMeta): string => host.id));
      this.loaded = true;
      this.loadError = '';
      if (!this.openPendingOnboarding(context)) { this.startProbes(); }
    }).catch((_e: Error) => {
      if (!this.visible || loadEpoch !== this.loadEpoch) { return; }
      this.loaded = true;
      this.loadError = '无法读取已配对桌面，请重试。';
      this.stopProbes();
    });
  }

  private openPendingOnboarding(context: common.Context): boolean {
    if (this.hosts.length === 0) { return false; }
    if (AppStorage.get<boolean>('explicitLaunchNavigation') === true) {
      this.onboardingChecked = true; this.onboardingPending = false; return false;
    }
    if (!this.onboardingChecked) {
      this.onboardingChecked = true;
      try { this.onboardingPending = loadMobileOnboardingSteps(context).length > 0; }
      catch (e) { return false; }
    }
    if (!this.onboardingPending) { return false; }
    if (!this.onboardingNavigating) {
      this.onboardingNavigating = true;
      router.replaceUrl({ url: 'pages/MobileOnboarding' }).catch(() => {
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
    let runtimes = Array.from(this.runtimes.values());
    this.runtimes.clear();
    for (let i = 0; i < runtimes.length; i++) {
      let rt = runtimes[i];
      if (rt.refreshTimer >= 0) { clearTimeout(rt.refreshTimer); }
      if (rt.watch) { rt.watch.stop(); rt.watch = null; }
      rt.session.stop();
    }
    this.accByHost.clear();
    this.online = {};
    this.usageByHost = {}; this.automationsByHost = {};
    this.usageErrors = {}; this.automationErrors = {};
    this.automationRunsByHost = {}; this.automationBusy = []; this.automationRequested = {};
    this.quotaOffers = {}; this.quotaAllowed = {}; this.quotaBusy = [];
    this.agentRows = [];
    this.summaries = {};
    this.connecting = false;
  }

  private startProbes(): void {
    this.stopProbes();
    let epoch = this.epoch;
    for (let i = 0; i < this.hosts.length; i++) { this.probeHost(this.hosts[i], epoch); }
  }

  private probeHost(host: HostMeta, epoch: number): void {
    getDeviceToken(getContext(this) as common.Context, host.id).then(async (token: string | null): Promise<void> => {
      if (!this.visible || epoch !== this.epoch || !token) { return; }
      let context = getContext(this) as common.Context;
      let relay = await getRelayCredential(context, host.id);
      if (!this.visible || epoch !== this.epoch) { return; }
      let session = new HostSession(host, token, relay ?? undefined, context);
      let rt: HostRuntime = { session: session, client: null, online: false,
        connecting: true, refreshTimer: -1, catalogPending: false, automationPending: false, automationFetchedAt: 0, watch: null };
      this.runtimes.set(host.id, rt);
      session.addListener((phase: SessionPhase, _detail: string): void => {
        if (epoch !== this.epoch || this.runtimes.get(host.id) !== rt) { return; }
        rt.online = phase === 'connected';
        rt.connecting = phase === 'connecting' || phase === 'reconnecting';
        if (rt.watch) { rt.watch.stop(); rt.watch = null; }
        if (rt.refreshTimer >= 0) { clearTimeout(rt.refreshTimer); rt.refreshTimer = -1; }
        rt.catalogPending = false; rt.automationPending = false;
        rt.client = session.getClient();
        if (rt.online && rt.client) {
          this.fetchCatalog(rt.client, host.id, epoch);
          this.subscribeUsage(rt.client, host.id, epoch);
          this.fetchAutomations(rt.client, host.id, epoch);
          this.fetchStats(rt.client, host.id, epoch);
          this.fetchQuotaCapability(rt.client, host.id, epoch);
          this.startHostNotifications(rt.client, host.id, epoch);
        } else {
          this.accByHost.delete(host.id);
          this.usageByHost[host.id] = []; this.automationsByHost[host.id] = [];
        }
        this.syncConnState();
      });
      session.start();
      this.syncConnState();
    }).catch((_e: Error): void => {});
  }

  private startHostNotifications(client: SpikeRpcClient, hostId: string, epoch: number): void {
    let context = getContext(this) as common.UIAbilityContext;
    getBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED).then((enabled: boolean): void => {
      let found = this.runtimes.get(hostId);
      if (!enabled || epoch !== this.epoch || !found || found.client !== client || found.watch) { return; }
      let runtime: HostRuntime = found;
      let notifier = this.notifier;
      notifier.setContext(context); notifier.setViewing('', '');
      notifier.ensureSlot().then((): void => {
        if (epoch !== this.epoch || this.runtimes.get(hostId) !== runtime || runtime.client !== client) { return; }
        let watch = new AgentWatch({ deviceToken: client.deviceToken, hostId: hostId,
          subscribe: (id: string, wire: string, onEvent: (frame: string) => void): boolean => client.subscribeWithId(id, wire, onEvent),
          cancel: (id: string): void => client.cancelById(id),
          notify: (title: string, body: string, host: string, worktree: string, paneKey?: string, executionHost?: string): boolean =>
            notifier.publishAgentEvent(title, body, host, worktree, paneKey, executionHost),
          notifyEvent: (event: DesktopNotification): boolean => notifier.publishDesktopEvent(event),
          dismiss: (id: string): void => { notifier.dismiss(id).catch(() => {}); },
          logSink: (_line: string): void => {} });
        runtime.watch = watch; watch.start();
      }).catch(() => {});
    }).catch(() => {});
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

  private fetchQuotaCapability(client: SpikeRpcClient, hostId: string, epoch: number): void {
    client.request('status.get', null, 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      let allowed = false;
      if (response instanceof RpcSuccess) {
        try {
          let value = JSON.parse(response.result) as Record<string, Object>;
          let caps = value['capabilities'];
          allowed = Array.isArray(caps) && (caps as Array<Object>).includes('accounts.codex-reset-credit.v1');
        } catch (e) {}
      }
      let next: Record<string, boolean> = {};
      let keys = Object.keys(this.quotaAllowed);
      for (let i = 0; i < keys.length; i++) { next[keys[i]] = this.quotaAllowed[keys[i]]; }
      next[hostId] = allowed; this.quotaAllowed = next;
    }).catch(() => {});
  }

  private applyQuotaOffer(hostId: string, json: string): void {
    let value = readHomeQuotaOffer(json);
    let next: Record<string, HomeQuotaOffer> = {};
    let keys = Object.keys(this.quotaOffers);
    for (let i = 0; i < keys.length; i++) { if (keys[i] !== hostId) { next[keys[i]] = this.quotaOffers[keys[i]]; } }
    if (value) { next[hostId] = value; }
    this.quotaOffers = next;
  }

  quotaCount(hostId: string, card: HomeUsageCard): number {
    let offer = this.quotaOffers[hostId];
    return this.quotaAllowed[hostId] === true && offer && card.provider === 'codex'
      && card.key === `codex:${offer.scope.accountId}` ? offer.availableCount : 0;
  }

  async resetQuota(host: HostMeta, card: HomeUsageCard): Promise<void> {
    let offered = this.quotaOffers[host.id];
    let rt = this.runtimes.get(host.id);
    if (!offered || this.quotaCount(host.id, card) === 0 || !rt || !rt.client || !rt.online || this.quotaBusy.includes(host.id)) { return; }
    let offer: HomeQuotaOffer = offered;
    let client: SpikeRpcClient = rt.client;
    let epoch = this.epoch;
    let frozen: HomeQuotaScope = { target: { runtime: offer.scope.target.runtime, wslDistro: offer.scope.target.wslDistro },
      accountId: offer.scope.accountId, accountRevision: offer.scope.accountRevision, offerRevision: offer.scope.offerRevision };
    this.quotaBusy = this.quotaBusy.concat(host.id);
    let attempted = false;
    try {
      let runtime = frozen.target.runtime === 'wsl' ? `WSL · ${frozen.target.wslDistro}` : '桌面主机';
      let answer = await promptAction.showDialog({ title: uiText('使用额度重置次数？', this.uiLocale),
        message: `${host.name} · ${runtime}\n${offer.accountLabel}\n将为此账户使用一次额度重置机会。`,
        buttons: [{ text: uiText('取消', this.uiLocale), color: this.pal().textSecondary }, { text: uiText('使用一次', this.uiLocale), color: this.pal().accentBlue }] });
      if (answer.index !== 1 || epoch !== this.epoch || this.runtimes.get(host.id)?.client !== client) { return; }
      attempted = true;
      let result = await consumeHomeQuotaReset(client, frozen);
      if (epoch !== this.epoch || this.runtimes.get(host.id)?.client !== client) { return; }
      let json = `{"result":{"type":"snapshot","snapshot":${result.snapshot}}}`;
      let cards = readHomeUsage(json);
      if (cards) {
        let next: Record<string, HomeUsageCard[]> = {};
        let keys = Object.keys(this.usageByHost);
        for (let i = 0; i < keys.length; i++) { next[keys[i]] = this.usageByHost[keys[i]]; }
        next[host.id] = cards; this.usageByHost = next;
      }
      this.applyQuotaOffer(host.id, json);
      let message = result.outcome === 'reset' ? '额度已重置'
        : result.outcome === 'nothingToReset' ? '当前额度无需重置'
        : result.outcome === 'noCredit' ? '已无可用重置次数'
        : result.outcome === 'alreadyRedeemed' ? '这次重置机会已使用' : '账户或重置机会已变化，请核对后重试';
      this.setHostError('usageErrors', host.id, message);
    } catch (e) {
      if (attempted && epoch === this.epoch) { this.setHostError('usageErrors', host.id, '重置结果未获确认，请刷新账户用量后核对；不会自动重试。'); }
    } finally {
      this.quotaBusy = this.quotaBusy.filter((id: string): boolean => id !== host.id);
    }
  }

  private subscribeUsage(client: SpikeRpcClient, hostId: string, epoch: number): void {
    let id = `home-accounts-${hostId}`;
    let wire = JSON.stringify({ id: id, deviceToken: client.deviceToken, method: 'accounts.subscribe' });
    let started = client.subscribeWithId(id, wire, (json: string): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      this.applyQuotaOffer(hostId, json);
      let rows = readHomeUsage(json);
      if (rows !== null) {
        let next: Record<string, HomeUsageCard[]> = {};
        let keys = Object.keys(this.usageByHost);
        for (let i = 0; i < keys.length; i++) { next[keys[i]] = this.usageByHost[keys[i]]; }
        next[hostId] = rows; this.usageByHost = next;
        this.setHostError('usageErrors', hostId, '');
      } else {
        this.setHostError('usageErrors', hostId, '账户用量暂不可用，可打开账户页重试。');
      }
    });
    if (!started) { this.setHostError('usageErrors', hostId, '账户用量订阅失败。'); }
  }

  private fetchAutomations(client: SpikeRpcClient, hostId: string, epoch: number): Promise<void> {
    let found = this.runtimes.get(hostId);
    if (!found || found.client !== client || found.automationPending) { return Promise.resolve(); }
    let rt: HostRuntime = found;
    rt.automationPending = true; rt.automationFetchedAt = Date.now();
    return client.request('automation.list', '{}', 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId)?.client !== client) { return; }
      rt.automationPending = false;
      let rows = response instanceof RpcSuccess ? readHomeAutomations(response.result) : null;
      if (rows !== null) {
        let next: Record<string, HomeAutomation[]> = {};
        let keys = Object.keys(this.automationsByHost);
        for (let i = 0; i < keys.length; i++) { next[keys[i]] = this.automationsByHost[keys[i]]; }
        next[hostId] = rows; this.automationsByHost = next;
        this.fetchAutomationRuns(client, hostId, epoch);
        this.setHostError('automationErrors', hostId, '');
      } else {
        this.setHostError('automationErrors', hostId, '自动化列表不可用，请打开自动化页重试。');
      }
    }).catch(() => {
      if (epoch === this.epoch && rt.client === client) { rt.automationPending = false; }
    });
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
      await this.fetchAutomations(client, hostId, epoch);
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

  private fetchCatalog(client: SpikeRpcClient, hostId: string, epoch: number): void {
    let found = this.runtimes.get(hostId);
    if (!found || found.client !== client || found.catalogPending) { return; }
    let rt: HostRuntime = found;
    rt.catalogPending = true;
    // No afterSnapshotId: every reply is a full replacement, never a delta against a missing base.
    client.request('worktree.ps', JSON.stringify({ limit: 10000 }), 8000).then((response: RpcResponse): void => {
      if (epoch !== this.epoch || this.runtimes.get(hostId) !== rt || rt.client !== client) { return; }
      rt.catalogPending = false;
      if (response instanceof RpcSuccess) {
        let rows = readHomeCatalog(response.result);
        if (rows !== null) { this.accByHost.set(hostId, rows); }
        else { this.accByHost.delete(hostId); }
      } else { this.accByHost.delete(hostId); }
      this.rebuildRows();
      if (Date.now() - rt.automationFetchedAt > 15000) { this.fetchAutomations(client, hostId, epoch); }
      rt.refreshTimer = setTimeout((): void => {
        rt.refreshTimer = -1;
        if (epoch === this.epoch && rt.online) { this.fetchCatalog(client, hostId, epoch); }
      }, 3000);
    }).catch((): void => {
      if (epoch !== this.epoch || rt.client !== client) { return; }
      rt.catalogPending = false;
      this.accByHost.delete(hostId);
      this.rebuildRows();
      rt.refreshTimer = setTimeout((): void => this.fetchCatalog(client, hostId, epoch), 3000);
    });
  }

  private refreshSummaries(): void {
    let next: Record<string, string> = {};
    this.accByHost.forEach((rows: HomeWorktree[], hostId: string): void => {
      let active = rows.filter((row: HomeWorktree): boolean => row.state !== 'inactive').length;
      next[hostId] = `${rows.length} 个工作区${active > 0 ? ` · ${active} 个活跃` : ''}`;
    });
    this.summaries = next;
  }

  private rebuildRows(): void {
    let rows: JumpRow[] = [];
    let multipleHosts = this.hosts.length > 1;
    this.accByHost.forEach((hostAcc: HomeWorktree[], hostId: string): void => {
      let hostName = hostId;
      for (let i = 0; i < this.hosts.length; i++) {
        if (this.hosts[i].id === hostId) {
          hostName = this.hosts[i].name;
          break;
        }
      }
      hostAcc.forEach((acc: HomeWorktree): void => {
        // 只展示有内容的行：空闲/无 agent 状态的 worktree 不进「智能体」区（上游同样按需隐藏）
        if (!isHomeAttention(acc)) {
          return;
        }
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
          state: acc.state, unread: acc.unread, lastOutputAt: acc.lastOutputAt,
          paneKey: acc.paneKey, executionHost: acc.executionHost, lastOpened: false, actionable: true
        });
      });
    });
    rows.sort((a: JumpRow, b: JumpRow): number => homeAttentionRank(a.state) - homeAttentionRank(b.state)
      || b.lastOutputAt - a.lastOutputAt);
    rows = rows.slice(0, 25);
    let heldResume = this.resume;
    if (heldResume) {
    let resume: HomeResume = heldResume;
    if ( this.hosts.some((host: HostMeta): boolean => host.id === resume.hostId)
      && !rows.some((row: JumpRow): boolean => row.hostId === resume.hostId
        && row.worktreeId === resume.worktreeId && row.executionHost === resume.executionHost)) {
      let host = this.hosts.find((candidate: HostMeta): boolean => candidate.id === resume.hostId);
      rows.push({ hostId: resume.hostId, hostName: host ? host.name : '', worktreeId: resume.worktreeId,
        title: resume.title, repo: resume.repo, state: 'inactive', unread: false, lastOutputAt: 0,
        paneKey: resume.paneKey, executionHost: resume.executionHost, lastOpened: true,
        actionable: this.online[resume.hostId] === true });
    }
    }
    this.agentRows = rows;
    this.refreshSummaries();
  }

  stateLabel(state: string): string {
    if (state === 'working') {
      return uiText('工作中', this.uiLocale);
    }
    if (state === 'monitoring') {
      return uiText('监控后台任务', this.uiLocale);
    }
    if (state === 'waiting' || state === 'interactivePrompt') {
      return uiText('等待输入', this.uiLocale);
    }
    if (state === 'blocked' || state === 'permission') {
      return uiText('已阻塞', this.uiLocale);
    }
    if (state === 'done') {
      return uiText('已完成', this.uiLocale);
    }
    if (state === 'failed') {
      return uiText('失败', this.uiLocale);
    }
    if (state === 'interrupted') {
      return uiText('已中断', this.uiLocale);
    }
    return uiText('空闲', this.uiLocale);
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
    this.openHostRoute(hostId, '');
  }

  openHostRoute(hostId: string, suffix: string, params: Record<string, string> = {}): void {
    let routeParams: Record<string, string> = { 'hostId': hostId, 'route': `/h/${encodeURIComponent(hostId)}${suffix}` };
    let keys = Object.keys(params);
    for (let i = 0; i < keys.length; i++) { routeParams[keys[i]] = params[keys[i]]; }
    router.pushUrl({ url: 'pages/ShellScreen', params: routeParams }).catch(() => {});
  }

  openSession(row: JumpRow): void {
    if (!row.actionable) { return; }
    let catalog = this.accByHost.get(row.hostId);
    if (row.lastOpened && catalog && !catalog.some((item: HomeWorktree): boolean =>
      item.worktreeId === row.worktreeId && item.executionHost === row.executionHost)) {
      this.openHostRoute(row.hostId, ''); return;
    }
    let resume: HomeResume = { hostId: row.hostId, worktreeId: row.worktreeId, title: row.title,
      repo: row.repo, paneKey: row.paneKey, executionHost: row.executionHost };
    try { saveHomeResume(getContext(this), resume); } catch (e) {}
    let params: Record<string, string> = { 'paneKey': row.paneKey, 'executionHost': row.executionHost };
    this.openHostRoute(row.hostId, `/session/${encodeURIComponent(row.worktreeId)}`, params);
  }

  openPairScan(): void {
    router.pushUrl({ url: 'pages/PairScan' }).catch(() => {});
  }

  openNewWorkspace(): void {
    let hosts = this.hosts.filter((host: HostMeta): boolean => this.online[host.id] === true);
    if (hosts.length === 1) { this.openHostRoute(hosts[0].id, '/new-workspace'); }
    else if (hosts.length > 1) { this.choosingHost = true; }
  }

  openNewAutomation(hostId: string): void {
    let params: Record<string, string> = { 'new': '1' };
    this.openHostRoute(hostId, '/automations', params);
  }

  async hostActions(host: HostMeta): Promise<void> {
    try {
      let choice = await promptAction.showActionMenu({ title: host.name,
        buttons: [{ text: uiText('编辑桌面', this.uiLocale), color: this.pal().textPrimary },
          { text: uiText('重新连接', this.uiLocale), color: this.pal().textPrimary },
          { text: uiText('连接诊断', this.uiLocale), color: this.pal().textPrimary },
          { text: uiText('重新配对', this.uiLocale), color: this.pal().textPrimary },
          { text: uiText('移除桌面', this.uiLocale), color: this.pal().statusRed }] });
      if (choice.index === 0) {
        router.pushUrl({ url: 'pages/HostDetail', params: { 'hostId': host.id } }).catch(() => {});
      } else if (choice.index === 1) { this.reload(); }
      else if (choice.index === 2) {
        router.pushUrl({ url: 'pages/HostDetail', params: { 'hostId': host.id, 'diagnostics': '1' } }).catch(() => {});
      } else if (choice.index === 3) { this.openPairScan(); }
      else if (choice.index === 4) { this.removeHost(host).catch(() => {}); }
    } catch (e) {}
  }

  async removeHost(host: HostMeta): Promise<void> {
    let answer = await promptAction.showDialog({
      title: uiText('移除主机', this.uiLocale),
      message: `要移除“${host.name}”吗？之后可重新配对。`,
      buttons: [{ text: uiText('取消', this.uiLocale), color: this.pal().textMuted }, { text: uiText('移除', this.uiLocale), color: this.pal().statusRed }]
    });
    if (answer.index !== 1) {
      return;
    }
    try {
      await deleteHost(getContext(this) as common.Context, host.id);
      await deletePageStorage(getContext(this) as common.Context, host.id);
      clearHomeResume(getContext(this), host.id);
      this.reload();
    } catch (e) {
      this.loadError = '移除失败，凭证或页面数据未能清理，请重试。';
    }
  }

  // ----------------------------------------------------------------- paint

  @Builder
  tabHeader(title: string) {
    Row() {
      Text(title)
        .fontFamily('Geist').fontSize(22)
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
        .fontFamily('Geist').fontSize(15 * this.fontScale)
        .fontWeight(FontWeight.Medium)
        .fontColor(this.pal().textPrimary)
        .maxLines(1)
      if (aside.length > 0) {
        Text(aside)
          .fontFamily('Geist').fontSize(13)
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

  jumpStatus(row: JumpRow): string {
    if (!row.lastOpened) { return this.stateLabel(row.state); }
    return row.actionable ? '上次打开' : `连接 ${row.hostName} 后打开`;
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
          .fontFamily('Geist').fontSize(16 * this.fontScale)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Row() {
          Text(uiText(this.jumpStatus(row), this.uiLocale))
            .fontFamily('Geist').fontSize(14)
            .fontColor(this.statusTextColor(row.state))
            .maxLines(1)
          if (row.repo.length > 0) {
            Text(`${this.jumpStatus(row).length > 0 ? ' · ' : ''}${row.repo}`)
              .fontFamily('Geist').fontSize(14)
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
        Image($r('app.media.lucide_chevron_right')).supportSvg2(true)
          .width(16).height(16)
          .colorFilter(lucideColorFilter(this.pal().textMuted))
      }
      .padding({ left: 10, right: 14 })
      .margin({ top: 9 })
    }
    .width('100%')
    .padding({ left: 16 })
    .alignItems(VerticalAlign.Top)
    .opacity(row.actionable ? 1 : 0.45)
    .onClick(() => {
      this.openSession(row);
    })
  }

  @Builder
  desktopRow(host: HostMeta) {
    Row() {
      // 机器磁贴（上游 tile 30x30 圆角 10 + 角落连接点）
      Stack({ alignContent: Alignment.Center }) {
        Column()
          .width(30)
          .height(30)
          .borderRadius(10)
          .backgroundColor(this.pal().bgRaised)
        Image($r('app.media.lucide_monitor')).supportSvg2(true)
          .width(17).height(17)
          .colorFilter(lucideColorFilter(this.pal().textPrimary))
        Circle({ width: 14, height: 14 })
          .fill(this.online[host.id] === true ? this.pal().statusGreen : this.pal().textMuted)
          .stroke(this.pal().bgPanel)
          .strokeWidth(2)
          .position({ x: 21, y: 21 })
      }
      .width(30)
      .height(30)
      .margin({ top: 9, right: 11 })

      Column() {
        Text(host.name)
          .fontFamily('Geist').fontSize(16 * this.fontScale)
          .fontColor(this.pal().textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
          .width('100%')
        Row() {
          Text(this.hostStatusLine(host))
            .fontFamily('Geist').fontSize(14)
            .fontColor(this.online[host.id] === true
              ? this.pal().textSecondary
              : (this.connecting ? this.pal().statusAmber : this.pal().textSecondary))
            .maxLines(1)
          Text(` · ${host.endpoint}`)
            .fontFamily('Geist').fontSize(14)
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
        Image($r('app.media.lucide_chevron_right')).supportSvg2(true)
          .width(16).height(16)
          .colorFilter(lucideColorFilter(this.pal().textMuted))
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
      this.hostActions(host);
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

  /** 连接行的状态文案：已连接 → worktree 概要（上游 homeHostWorktreeSummary）。 */
  hostStatusLine(host: HostMeta): string {
    if (this.online[host.id] !== true) {
      let runtime = this.runtimes.get(host.id);
      return runtime && runtime.connecting ? '正在连接' : '离线';
    }
    let summary = this.summaries[host.id];
    return summary !== undefined && summary.length > 0 ? summary : '已连接';
  }

  @Builder
  feedTab() {
    Column() {
      this.tabHeader(uiText('动态', this.uiLocale))
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
            if (this.agentRows.length > 0) {
              this.sectionHeading(uiText('智能体', this.uiLocale), `${this.activeCountText()}`, true)
              Column() {
                ForEach(this.agentsExpanded ? this.agentRows : this.agentRows.slice(0, 5), (row: JumpRow, index: number) => {
                  Column() {
                    if (index > 0) {
                      this.hairline(40)
                    }
                    this.jumpRow(row)
                  }
                  .width('100%')
                }, (row: JumpRow, index: number) => `${row.hostId}-${row.executionHost}-${row.worktreeId}`)
                if (this.agentRows.length > 5) {
                  Button(this.agentsExpanded ? uiText('收起', this.uiLocale) : `${uiText('显示全部', this.uiLocale)} ${this.agentRows.length}`)
                    .fontColor(this.pal().textSecondary).backgroundColor(Color.Transparent)
                    .onClick(() => { this.agentsExpanded = !this.agentsExpanded; })
                }
              }
              .width('100%')
              .borderRadius(16)
              .backgroundColor(this.pal().bgPanel)
              .clip(true)
            }

            this.sectionHeading(uiText('台式机', this.uiLocale), '', this.agentRows.length === 0)
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
            .margin({ bottom: 8 })
            Button(uiText('配对另一台桌面', this.uiLocale)).fontFamily('Geist').fontSize(16).fontColor(this.pal().accentBlue)
              .backgroundColor(Color.Transparent).constraintSize({ minHeight: 44 })
              .onClick(() => this.openPairScan())
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
    let count = this.agentRows.filter((row: JumpRow): boolean => !row.lastOpened).length;
    return count > 0 ? `${count} 个活跃` : '';
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
          .fontFamily('Geist').fontSize(17 * this.fontScale)
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
          Image($r('app.media.icon'))
            .width(44)
            .height(44)
            .borderRadius(10)
          Text(uiText('连接桌面', this.uiLocale))
            .fontFamily('Geist').fontSize(28 * this.fontScale)
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
          this.hairline(46)
          this.stepRow(2, '扫描二维码', '轻点下方“配对桌面”，扫描电脑屏幕上的二维码。')
          this.hairline(46)
          this.stepRow(3, '已连接', '桌面将显示在这里。所有数据均采用端到端加密。')
        }
        .width('100%')
        .borderRadius(16)
        .backgroundColor(this.pal().bgPanel)
        .clip(true)

        Row({ space: 8 }) {
          Image($r('app.media.lucide_qr_code')).supportSvg2(true)
            .width(18).height(18)
            .colorFilter(lucideColorFilter(this.pal().onAccent))
          Text(uiText('配对桌面', this.uiLocale))
            .fontFamily('Geist').fontSize(16)
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
  usageCard(host: HostMeta, card: HomeUsageCard) {
    Column({ space: 8 }) {
      Text(`${card.provider === 'claude' ? 'Claude' : 'Codex'} · ${card.account}`)
        .fontFamily('Geist').fontSize(15).fontColor(this.pal().textPrimary).maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis })
      ForEach(card.windows, (window: HomeUsageWindow) => {
        Row() {
          Text(uiText(window.label, this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary).layoutWeight(1)
          Text(`${Math.round(window.usedPercent)}% 已使用`).fontFamily('Geist').fontSize(14).fontColor(this.pal().textPrimary)
        }.width('100%')
        Progress({ value: window.usedPercent, total: 100, type: ProgressType.Linear })
          .color(this.pal().accentBlue).backgroundColor(this.pal().bgRaised).width('100%')
      })
      if (this.quotaCount(host.id, card) > 0) {
        Button(`使用额度重置（剩余 ${this.quotaCount(host.id, card)} 次）`).fontFamily('Geist').fontSize(14)
          .fontColor(this.pal().accentBlue).backgroundColor(Color.Transparent)
          .enabled(!this.quotaBusy.includes(host.id))
          .onClick(() => { this.resetQuota(host, card).catch(() => {}); })
      }
      if (card.windows.length === 0) {
        Text(uiText(card.status === 'fetching' || card.status === 'idle' ? '正在获取用量…' : '用量暂不可用', this.uiLocale))
          .fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary)
      }
    }
    .alignItems(HorizontalAlign.Start).width('100%').padding(16)
    .borderRadius(16).backgroundColor(this.pal().bgPanel).margin({ bottom: 8 })

  }

  @Builder
  hostTabAction(host: HostMeta, label: string, suffix: string) {
    Button(label).fontFamily('Geist').fontSize(15).fontColor(this.pal().accentBlue)
      .backgroundColor(Color.Transparent).constraintSize({ minHeight: 44 })
      .onClick(() => this.openHostRoute(host.id, suffix))
  }

  formatAgentTime(milliseconds: number): string {
    let minutes = Math.max(0, Math.floor(milliseconds / 60000));
    let hours = Math.floor(minutes / 60); let days = Math.floor(hours / 24);
    return days > 0 ? `${days}d` : hours > 0 ? `${hours}h` : `${minutes}m`;
  }

  @Builder
  statsCell(value: string, label: string) {
    Column({ space: 2 }) {
      Text(value).fontFamily('Geist').fontSize(20).fontWeight(FontWeight.Medium).fontColor(this.pal().textPrimary).maxLines(1)
      Text(uiText(label, this.uiLocale)).fontFamily('Geist').fontSize(13).fontColor(this.pal().textSecondary).maxLines(2).textAlign(TextAlign.Center)
    }.layoutWeight(1).padding({ top: 13, bottom: 12, left: 8, right: 8 })
  }

  @Builder
  statsSummary() {
    if (this.statsTotal !== null) {
      this.sectionHeading(uiText('你的统计', this.uiLocale), '', true)
      Row() {
        this.statsCell(this.statsTotal!.totalAgentsSpawned.toLocaleString(), '已启动智能体')
        this.statsCell(this.formatAgentTime(this.statsTotal!.totalAgentTimeMs), '智能体工作时间')
        this.statsCell(this.statsTotal!.totalPRsCreated.toLocaleString(), '已创建 PR')
      }.width('100%').borderRadius(16).backgroundColor(this.pal().bgPanel).margin({ bottom: 12 })
    }
  }

  @Builder
  usageTab() {
    Column() {
      this.tabHeader(uiText('使用情况', this.uiLocale))
      Scroll() {
        Column() {
          this.statsSummary()
          if (this.hosts.length === 0) {
            this.tabEmptyState($r('app.media.lucide_gauge'), '暂无使用情况', '请先配对桌面，才能查看智能体账户使用情况。')
          }
          ForEach(this.hosts, (host: HostMeta) => {
            this.sectionHeading(host.name, this.hostStatusLine(host), true)
            if (this.online[host.id] === true) {
              if (this.usageByHost[host.id] !== undefined) {
                ForEach(this.usageByHost[host.id], (card: HomeUsageCard) => { this.usageCard(host, card) },
                  (card: HomeUsageCard) => card.key)
                if (this.usageByHost[host.id].length === 0) {
                  Text(uiText('此桌面暂无账户用量', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().textSecondary).padding(16)
                }
              } else if (!((this.usageErrors[host.id] ?? '').length > 0)) {
                Text(uiText('正在获取账户用量…', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().textSecondary).padding(16)
              }
              if ((this.usageErrors[host.id] ?? '').length > 0) {
                Text(uiText(this.usageErrors[host.id], this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary).padding(16)
              }
              this.hostTabAction(host, '管理账户与刷新用量', '/accounts')
            } else {
              Text(uiText('连接此桌面后查看用量', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().textSecondary).padding(16)
            }
          }, (host: HostMeta) => host.id)
        }.width('100%').padding({ left: 16, right: 16, bottom: 24 })
      }.scrollBar(BarState.Off).width('100%').layoutWeight(1)
    }.width('100%').height('100%')
  }

  @Builder
  automationsTab() {
    Column() {
      this.tabHeader(uiText('自动化', this.uiLocale))
      Scroll() {
        Column() {
          if (this.hosts.length === 0) {
            this.tabEmptyState($r('app.media.lucide_calendar_clock'), '安排智能体工作', '请先配对桌面，才能查看和运行自动化。')
          }
          ForEach(this.hosts, (host: HostMeta) => {
            this.sectionHeading(host.name, this.hostStatusLine(host), true)
            if (this.online[host.id] === true) {
              if (this.automationsByHost[host.id] !== undefined) {
                ForEach(this.automationsByHost[host.id], (row: HomeAutomation) => {
                  Row({ space: 12 }) {
                    Column({ space: 4 }) {
                      Text(row.name).fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary).maxLines(1)
                      Text(row.enabled ? `下次运行 ${new Date(row.nextRunAt).toLocaleString()}` : '已暂停')
                        .fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary)
                    }.alignItems(HorizontalAlign.Start).layoutWeight(1)
                      .onClick(() => this.openHostRoute(host.id, '/automations'))
                    Toggle({ type: ToggleType.Switch, isOn: this.automationRequested[`${host.id}:${row.id}`] ?? row.enabled })
                      .enabled(!this.automationBusy.includes(`${host.id}:${row.id}`))
                      .accessibilityText(`${row.name} 启用状态`)
                      .onChange((value: boolean) => { this.toggleAutomation(host.id, row, value).catch(() => {}); })
                  }.padding(16).width('100%').borderRadius(16).backgroundColor(this.pal().bgPanel).margin({ bottom: 8 })
                }, (row: HomeAutomation) => row.id)
                if (this.automationsByHost[host.id].length === 0) {
                  Text(uiText('暂无自动化', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().textSecondary).padding(16)
                }
              } else if (!((this.automationErrors[host.id] ?? '').length > 0)) {
                Text(uiText('正在加载自动化…', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().textSecondary).padding(16)
              }
              if ((this.automationErrors[host.id] ?? '').length > 0) {
                Text(uiText(this.automationErrors[host.id], this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary).padding(16)
              }
              if (this.automationRunsByHost[host.id] !== undefined && this.automationRunsByHost[host.id].length > 0) {
                this.sectionHeading(uiText('最近运行', this.uiLocale), '', false)
                ForEach(this.automationRunsByHost[host.id], (run: HomeAutomationRun) => {
                  Column({ space: 4 }) {
                    Text(run.title).fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary).maxLines(1)
                    Text(`${run.status} · ${new Date(run.createdAt).toLocaleString()}`).fontFamily('Geist').fontSize(14).fontColor(this.pal().textSecondary)
                  }.alignItems(HorizontalAlign.Start).width('100%').padding(16)
                    .borderRadius(16).backgroundColor(this.pal().bgPanel).margin({ bottom: 8 })
                    .onClick(() => this.openHostRoute(host.id, '/automations'))
                }, (run: HomeAutomationRun) => run.id)
              }
              Row({ space: 8 }) {
                this.hostTabAction(host, '管理与运行', '/automations')
                Button(uiText('新建', this.uiLocale)).fontFamily('Geist').fontSize(15).backgroundColor(this.pal().accentBlue).fontColor(this.pal().onAccent)
                  .onClick(() => this.openNewAutomation(host.id))
              }
              Button(uiText('刷新', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().accentBlue).backgroundColor(Color.Transparent)
                .onClick(() => this.refreshAutomations(host.id))
            } else {
              Text(uiText('连接此桌面后查看自动化', this.uiLocale)).fontFamily('Geist').fontSize(15).fontColor(this.pal().textSecondary).padding(16)
            }
          }, (host: HostMeta) => host.id)
        }.width('100%').padding({ left: 16, right: 16, bottom: 24 })
      }.scrollBar(BarState.Off).width('100%').layoutWeight(1)
    }.width('100%').height('100%')
  }

  @Builder
  settingsTab() {
    Column() {
      this.tabHeader(uiText('设置', this.uiLocale))
      Scroll() {
        Column() {
          Column() {
            ForEach(SETTINGS_MENU_ITEMS, (row: SettingsMenuItem, index: number) => {
              Column() {
                if (index > 0) {
                  this.hairline(46)
                }
                Row({ space: 11 }) {
                  Image(row.icon).supportSvg2(true)
                    .width(18).height(18)
                    .colorFilter(lucideColorFilter(this.pal().textSecondary))
                  Text(uiText(row.label, this.uiLocale))
                    .fontFamily('Geist').fontSize(16 * this.fontScale)
                    .fontColor(this.pal().textPrimary)
                    .maxLines(1)
                    .layoutWeight(1)
                  Image($r('app.media.lucide_chevron_right')).supportSvg2(true)
                    .width(14).height(14)
                    .colorFilter(lucideColorFilter(this.pal().textMuted))
                }
                .width('100%')
                .padding({ top: 12, bottom: 12, left: 16, right: 14 })
                .onClick(() => {
                  router.pushUrl({ url: row.target }).catch(() => {});
                })
              }
              .width('100%')
            }, (row: SettingsMenuItem, index: number) => `${index}-${row.target}`)
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
            Image(tab.icon).supportSvg2(true)
              .width(25).height(25)
              .colorFilter(lucideColorFilter(this.activeTab === tab.id ? this.pal().textPrimary : this.pal().textMuted))
            if (tab.id === 'feed' && this.needsYouCount() > 0) {
              Text(`${this.needsYouCount()}`)
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
        .accessibilityText(uiText(tab.label, this.uiLocale))
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
        Text(uiText('连接桌面以创建工作区', this.uiLocale))
          .fontFamily('Geist').fontSize(13)
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
        Image($r('app.media.lucide_plus')).supportSvg2(true)
          .width(26).height(26)
          .colorFilter(lucideColorFilter(this.pal().onAccent))
          .opacity(this.fabDisabled() ? 0.4 : 1)
      }
      .width(FAB_SIZE)
      .height(FAB_SIZE)
      .accessibilityText('新建工作区')
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
          Stack() {
            Column() { this.feedTab() }.width('100%').height('100%')
              .visibility(this.activeTab === 'feed' ? Visibility.Visible : Visibility.Hidden)
            Column() { this.usageTab() }.width('100%').height('100%')
              .visibility(this.activeTab === 'usage' ? Visibility.Visible : Visibility.Hidden)
            Column() { this.automationsTab() }.width('100%').height('100%')
              .visibility(this.activeTab === 'automations' ? Visibility.Visible : Visibility.Hidden)
            Column() { this.settingsTab() }.width('100%').height('100%')
              .visibility(this.activeTab === 'settings' ? Visibility.Visible : Visibility.Hidden)
          }.width('100%').height('100%')
        }
        .width('100%')
        .height('100%')

        if (this.choosingHost) {
          Column({ space: 12 }) {
            Text(uiText('选择桌面', this.uiLocale)).fontFamily('Geist').fontSize(18).fontColor(this.pal().textPrimary)
            ForEach(this.hosts, (host: HostMeta) => {
              if (this.online[host.id] === true) {
                Button(host.name).width('100%').fontFamily('Geist').fontSize(16).fontColor(this.pal().textPrimary)
                  .backgroundColor(this.pal().bgPanel).onClick(() => {
                    this.choosingHost = false; this.openHostRoute(host.id, '/new-workspace');
                  })
              }
            }, (host: HostMeta) => host.id)
            Button(uiText('取消', this.uiLocale)).fontColor(this.pal().textSecondary).backgroundColor(Color.Transparent)
              .onClick(() => { this.choosingHost = false; })
          }.width('100%').height('100%').padding(24).justifyContent(FlexAlign.Center)
            .backgroundColor(this.pal().bgBase)
        }

        if (!this.choosingHost && this.activeTab === 'feed' && this.loaded && this.hosts.length > 0) {
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

function isNeedsYou(state: string): boolean {
  return state === 'permission' || state === 'failed';
}
