import { uiText } from '../settings/NativeUi';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { readHomeResume, saveHomeResume, resumeFromLocation } from '../home/HomeResume';
import { NATIVE_DEVICE_METHODS, NativeDevice } from './NativeDevice';
import { PageStorageStore } from '../storage/PageStorageStore';
import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR, LOG_LEVEL_WARN } from '../diagnostics/ConnectionLogStore';
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import {
  BundleCompatibilityError, BundleManifest, BundleRemedy, CachedWebBundle, DesktopBundleStatus, WebBundleFetcher
} from '../transport/WebBundleFetcher';
import { ShellStartup } from './ShellStartup';
import { ShellDocument, ShellDocumentMount } from './ShellDocument';
import { claimHomeDocument } from './HomeShellPrewarm';
import { BridgeHost, BridgeNativePage } from './BridgeHost';
import { HostMeta } from '../storage/HostStore';
import { desktopPath, isDesktopSession, sessionOpenParam, ShellRoute } from '../navigation/ShellRoute';
import { lucideColorFilter } from '../settings/LucideColor';
import { projectPageRegions, projectSideRail, readWindowRegions, WindowRegion } from './WindowRegions';
import { TerminalKeyRail } from './TerminalKeyRail';
import { BundleCompatibilityCard } from './BundleCompatibilityCard';
import { terminalRailKeys, TerminalRailClaim } from './TerminalRailClaim';
import terminalRail, { SideRailStrip } from '../vendor/terminal-rail.js';

type ShellStage = 'checking' | 'downloading' | 'opening' | 'offline' | 'repair' | 'failed' | 'incompatible' | 'ready';

interface BundleActivationFallback {
  bundle: CachedWebBundle;
  pathname: string;
  params: Record<string, string>;
  target: ShellRoute | null;
}

export class ShellSurfaceBack {
  private handler: (() => boolean) | null = null;

  bind(handler: () => boolean): () => void {
    this.handler = handler;
    return (): void => { if (this.handler === handler) { this.handler = null; } };
  }

  handle(): boolean { return this.handler?.() ?? false; }
}

@Component
export struct ShellSurface {
  @Prop request: ShellRoute = { hostId: '', pathname: '', params: {} };
  @Prop sessionTarget: ShellRoute | null = null;
  @Prop @Watch('onVisibilityChanged') visible: boolean = true;
  asDrawer: boolean = false;
  returnsToDesktop: boolean = false;
  back: ShellSurfaceBack = new ShellSurfaceBack();
  onNativeSession: (route: ShellRoute) => void = (_route: ShellRoute): void => {};
  onNativeRoute: (route: ShellRoute, replace: boolean) => void = (_route: ShellRoute, _replace: boolean): void => {};
  onOverlayClose: () => void = (): void => {};
  onOverlayNavigate: (route: ShellRoute) => void = (_route: ShellRoute): void => {};
  private unbindBack: (() => void) | null = null;
  @StorageProp('uiLocale') @Watch('onLocaleChanged') uiLocale: string = 'en';
  @StorageProp('themeScheme') @Watch('onThemeChanged') scheme: string = 'dark';
  @StorageProp('shellKeyboardTop') @Watch('publishWindowLayout') keyboardTop: number = -1;
  @StorageProp('shellWindowRegions') @Watch('publishPageRegions') windowRegions: string = '';
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeStatusRed') themeStatusRed: string = '#ff6568';
  private document: ShellDocument | null = null;
  private documentMount: ShellDocumentMount = new ShellDocumentMount();
  private bridge: BridgeHost | null = null;
  private client: SpikeRpcClient | null = null;
  private hostId: string = '';
  private phase: string = '';
  @State stage: ShellStage = 'checking';
  @State failureMessage: string = '';
  @State bundleRemedy: BundleRemedy = 'desktop';
  @State desktopName: string = '';
  @State downloadPercent: number = -1;
  @State downloadCaption: string = '';
  @State wideDrawer: boolean = false;
  @State painted: boolean = false;
  @State updateFailed: boolean = false;
  @State sideRail: SideRailStrip | null = null;
  @State railClaim: TerminalRailClaim | null = null;
  @State railKeys: string[] = [];
  @State directionPadAvailable: boolean = false;
  private startup: ShellStartup = new ShellStartup((message: string): void => this.failStartup(message));
  private startupGeneration: number = 0;
  private routePathname: string = '';
  private routeParams: Record<string, string> = {};
  private desktop: DesktopConnectionLease | null = null;
  private unobserveDesktop: (() => void) | null = null;
  private viewingOwner: Object = new Object();
  private nativeDevice: NativeDevice | null = null;
  private disposed: boolean = false;
  private pageVisible: boolean = true;
  private foreground: boolean = true;
  private viewport: WindowRegion = { x: 0, y: 0, width: 0, height: 0 };
  private surface: WindowRegion = { x: 0, y: 0, width: 0, height: 0 };
  private pendingDrawerRoute: ShellRoute | null = null;
  private pendingSession: ShellRoute | null = null;
  private opensSessionNatively: boolean = false;
  private triedCachedBundle: boolean = false;
  private cacheOnly: boolean = false;
  private attachingClient: SpikeRpcClient | null = null;
  private activationFallback: BundleActivationFallback | null = null;
  private foregroundListener: () => void = (): void => {
    this.foreground = true; this.publishKeyboardInset(); this.publishPageRegions(); this.updateViewing();
    this.flushDrawerRoute();
    this.openPendingNativeSession();
  };
  private generation: number = 0;
  private backgroundListener: () => void = (): void => {
    this.foreground = false; this.publishPageRegions(); this.clearViewing();
    if (this.nativeDevice) { this.nativeDevice.pause().catch(() => {}); }
  };

  aboutToAppear(): void {
    this.hostId = this.request.hostId;
    this.routePathname = this.request.pathname;
    this.routeParams = this.request.params;
    this.pendingSession = this.sessionTarget;
    this.pageVisible = this.visible;
    this.unbindBack = this.back.bind((): boolean => this.handleBack());
    (getContext(this) as common.UIAbilityContext).eventHub.on('orcaBackground', this.backgroundListener);
    (getContext(this) as common.UIAbilityContext).eventHub.on('orcaForeground', this.foregroundListener);
    this.boot();
  }

  onLocaleChanged(): void {
    if (this.bridge) { this.bridge.setUiLocale(this.uiLocale); }
  }

  onThemeChanged(): void {
    if (this.bridge) { this.bridge.setColorScheme(this.scheme); }
  }

  aboutToDisappear(): void {
    this.disposed = true; this.generation++; this.startup.cancel();
    this.unbindBack?.(); this.unbindBack = null;
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaBackground', this.backgroundListener);
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaForeground', this.foregroundListener);
    this.clearViewing();
    this.unobserveDesktop?.(); this.unobserveDesktop = null;
    this.desktop?.release(true); this.desktop = null;
    this.releaseBridge();
  }
  private handleBack(): boolean {
    if (this.painted && this.bridge?.handleBack()) { return true; }
    if (!this.asDrawer) { return false; }
    this.onOverlayClose(); return true;
  }

  private navigateBack(home: boolean = false): void {
    if (this.disposed || !this.pageVisible || !this.foreground) { return; }
    if (this.asDrawer) { this.onOverlayClose(); }
    else if (home) { router.back({ url: 'pages/Home' }); }
    else { router.back(); }
  }

  private onVisibilityChanged(): void {
    this.pageVisible = this.visible;
    if (this.pageVisible) { this.publishKeyboardInset(); this.publishPageRegions(); this.updateViewing(); this.flushDrawerRoute(); }
    else {
      this.publishPageRegions();
      this.pendingSession = null;
      this.clearViewing();
      this.nativeDevice?.pause().catch(() => {});
    }
  }

  private openPendingNativeSession(): void {
    let target = this.pendingSession;
    if (!target || !this.opensSessionNatively || !this.painted || !this.client
      || !this.pageVisible || !this.foreground || this.disposed) { return; }
    this.pendingSession = null;
    this.onNativeSession(target);
  }

  private openOverlayRoute(pathname: string, params: Record<string, string>): void {
    if (this.disposed || this.pendingDrawerRoute) { return; }
    this.pendingDrawerRoute = { hostId: this.hostId, pathname: pathname, params: params };
    this.flushDrawerRoute();
  }

  private flushDrawerRoute(): void {
    let route = this.pendingDrawerRoute;
    if (!route || this.disposed || !this.pageVisible || !this.foreground) { return; }
    this.pendingDrawerRoute = null;
    this.onOverlayNavigate(route);
  }

  private publishKeyboardInset(): void {
    if (!this.pageVisible || !this.foreground || !this.bridge) { return; }
    let covered = this.keyboardTop < 0 ? 0 : this.viewport.y + this.viewport.height - this.keyboardTop;
    this.bridge.setKeyboardInset(Math.max(0, Math.min(this.viewport.height, covered)));
  }

  private publishWindowLayout(): void { this.publishKeyboardInset(); this.publishPageRegions(); }

  private publishPageRegions(): void {
    let bridge = this.bridge;
    if (!bridge) { return; }
    let visible = this.pageVisible && this.foreground;
    bridge.setTerminalRailFocus(visible && this.painted);
    let regions = readWindowRegions(this.windowRegions);
    let capable = !this.asDrawer && bridge.hasTerminalRail();
    let strip = capable ? projectSideRail(regions, this.surface, this.keyboardTop) : null;
    if (JSON.stringify(this.sideRail) !== JSON.stringify(strip)) { this.sideRail = strip; }
    this.directionPadAvailable = capable && terminalRail.hasTerminalDirectionPadSpace(projectSideRail(regions, this.surface));
    let keys = visible && this.painted && strip && this.railClaim ? terminalRailKeys(this.railClaim) : [];
    if (JSON.stringify(this.railKeys) !== JSON.stringify(keys)) { this.railKeys = keys; }
    let page = projectPageRegions(regions, this.viewport);
    bridge.setPageGeometry({ occlusions: page.occlusions, sideRail: strip !== null,
      directionPadAvailable: this.directionPadAvailable }, page.division, keys);
  }
  private clearViewing(): void { this.desktop?.connection.clearViewing(this.viewingOwner); }
  private updateViewing(): void {
    if (!this.pageVisible || !this.foreground || !this.painted || !this.bridge) { this.clearViewing(); return; }
    let route = resumeFromLocation(this.hostId, this.bridge.getRoute(), this.bridge.getRouteParams());
    if (route) { this.desktop?.connection.setViewing(this.viewingOwner, route.worktreeId, route.executionHost); }
    else { this.clearViewing(); }
  }
  private recordResume(pathname: string, params: Record<string, string>): void {
    try {
      let next = resumeFromLocation(this.hostId, pathname, params);
      if (next && this.pageVisible && this.foreground && this.painted) {
        this.desktop?.connection.setViewing(this.viewingOwner, next.worktreeId, next.executionHost);
      } else { this.clearViewing(); }
      if (!next) { return; }
      let held = readHomeResume(getContext(this));
      if (held && held.hostId === next.hostId && held.worktreeId === next.worktreeId
        && held.executionHost === next.executionHost) {
        if (!params['name']) { next.title = held.title; }
        next.repo = held.repo;
      }
      saveHomeResume(getContext(this), next);
    } catch (e) {}
  }

  private releaseBridge(): void {
    this.cacheOnly = false; this.attachingClient = null; this.activationFallback = null; this.updateFailed = false;
    this.downloadPercent = -1; this.downloadCaption = '';
    this.railClaim = null; this.railKeys = []; this.sideRail = null; this.directionPadAvailable = false;
    if (this.bridge) {
      this.routePathname = this.bridge.getRoute();
      this.routeParams = this.bridge.getRouteParams();
      this.recordResume(this.routePathname, this.routeParams);
      this.bridge.publishState('disconnected', 0); this.bridge.dispose(); this.bridge = null;
    }
    let document = this.document; this.document = null;
    if (document) { this.documentMount.setDocument(null); document.dispose(); }
    this.clearViewing();
    if (this.nativeDevice) { this.nativeDevice.dispose().catch(() => {}); this.nativeDevice = null; }
    this.client = null;
  }
  private suspendTransport(attempt: number): void {
    this.attachingClient = null;
    if (this.cacheOnly && this.bridge) {
      this.bridge.suspendTransport(attempt);
      return;
    }
    this.startup.cancel(); this.generation++;
    if (!this.painted || !this.bridge) { this.releaseBridge(); return; }
    this.client = null;
    this.nativeDevice?.setDesktopClient(null);
    this.bridge.suspendTransport(attempt);
  }
  private failStartup(message: string): void {
    if (this.disposed) { return; }
    if (!this.painted && this.restoreAfterFailedActivation()) { return; }
    this.startup.cancel(); this.generation++; this.releaseBridge();
    this.painted = false;
    this.failureMessage = message;
    this.publishPhase(`失败：${message}`, 'failed');
    if (this.asDrawer) {
      let generation = this.generation;
      setTimeout((): void => {
        if (generation === this.generation) { this.openOverlayRoute(`/h/${encodeURIComponent(this.hostId)}`, {}); }
      }, 0);
    }
  }

  private restoreAfterFailedActivation(): boolean {
    let fallback = this.activationFallback;
    let connection = this.desktop?.connection;
    let client = this.client;
    let meta = connection?.getPairedMeta();
    if (!fallback || !client || client !== connection?.getClient() || !meta) { return false; }
    let generation = ++this.generation;
    this.releaseBridge(); this.client = client;
    this.routePathname = fallback.pathname; this.routeParams = fallback.params; this.pendingSession = fallback.target;
    this.startupGeneration = this.startup.begin();
    try {
      this.mountBundle(client, meta, fallback.bundle.manifest, fallback.bundle.directory, generation);
      this.reportUpdateFailure('activation');
      return true;
    } catch (e) { return false; }
  }

  private reportUpdateFailure(step: string): void {
    this.updateFailed = true;
    recordConnection(getContext(this), LOG_LEVEL_WARN, '最新工作区更新失败，保留上次可用版本', step,
      this.hostId, 'web-shell-update-failed').catch(() => {});
  }

  private handleStartupFailure(error: Object): void {
    if (!(error instanceof BundleCompatibilityError)) { this.failStartup('会话加载未完成，请重试'); return; }
    this.startup.cancel(); this.generation++; this.releaseBridge();
    this.painted = false; this.bundleRemedy = error.remedy;
    if (!error.message.startsWith('page-route-')) { WebBundleFetcher.forgetPairedBundle(getContext(this), this.hostId); }
    this.publishPhase(`失败：${error.message}`, 'incompatible');
  }

  private rememberBundle(meta: HostMeta, document: ShellDocument): void {
    try { WebBundleFetcher.rememberPairedBundle(getContext(this), meta.id, meta.lastConnected, document.manifest); }
    catch (e) {}
  }

  private pagePainted(meta: HostMeta, document: ShellDocument, generation: number): void {
    if (this.disposed || generation !== this.generation || this.document !== document) { return; }
    if (this.startup.complete(this.startupGeneration)) {
      this.painted = true;
      this.activationFallback = null;
      if (this.client) { this.rememberBundle(meta, document); this.publishPhase('已连接', 'ready'); }
      this.updateViewing();
      this.publishPageRegions();
      if (this.opensSessionNatively) { this.openPendingNativeSession(); }
      else { this.pendingSession = null; }
    }
  }

  private publishPhase(state: string, stage: ShellStage): void {
    if (this.disposed) { return; }
    this.stage = stage;
    if (this.phase === state) { return; }
    this.phase = state;
    recordConnection(getContext(this), state.startsWith('失败') ? LOG_LEVEL_ERROR : LOG_LEVEL_INFO, state, '', this.hostId, 'web-shell-flow').catch(() => {});
  }

  private boot(): void {
    if (this.desktop || this.disposed) { return; }
    let context = getContext(this) as common.UIAbilityContext;
    let desktop = retainDesktopConnection(context, this.hostId);
    this.desktop = desktop;
    this.unobserveDesktop = desktop.connection.observe((phase: SessionPhase, detail: string): void => {
      if (this.disposed || this.desktop !== desktop) { return; }
      if (phase === 'connected') {
        let client = desktop.connection.getClient();
        let meta = desktop.connection.getPairedMeta();
        if (client && meta && client !== this.client) { this.loadConnected(client, meta).catch(() => {}); }
      } else if (phase === 'reconnecting' || phase === 'connecting') {
        if (this.client || this.bridge) { this.suspendTransport(desktop.connection.getReconnectAttempt()); }
        this.publishPhase(phase === 'connecting' ? '连接桌面…' : `连接中断 · ${detail}`,
          phase === 'connecting' ? 'checking' : 'offline');
        let meta = desktop.connection.getPairedMeta();
        if (meta) { this.openCachedBundle(meta); }
      } else if (phase === 'auth-failed') {
        WebBundleFetcher.forgetPairedBundle(context, this.hostId);
        if (this.asDrawer) { this.failStartup('凭证已失效，请重新配对'); return; }
        this.startup.cancel(); this.generation++; this.releaseBridge();
        this.publishPhase('凭证已失效，请重新配对', 'repair'); this.painted = false;
      } else if (phase === 'stopped') {
        if (this.asDrawer) { this.failStartup(detail); return; }
        if (this.client || this.bridge) { this.suspendTransport(0); }
        if (detail === '已断开') { this.publishPhase(detail, 'offline'); }
        else { this.failStartup(detail); }
      }
    });
    desktop.connection.connect(true);
  }

  private retryStartup(): void {
    let connection = this.desktop?.connection;
    if (!connection) { this.boot(); return; }
    let client = connection.getClient();
    let meta = connection.getPairedMeta();
    if (client && meta) { this.loadConnected(client, meta).catch(() => {}); }
    else { connection.reconnect(); }
  }

  private async loadConnected(client: SpikeRpcClient, meta: HostMeta): Promise<void> {
    if (this.document && this.bridge && this.nativeDevice) {
      await this.reattachDocument(client, meta, this.document);
      return;
    }
    await this.openConnectedBundle(client, meta);
  }

  private routeAdmission(manifest: BundleManifest): string {
    let root = desktopPath(this.hostId);
    let pathname = this.pendingSession || (this.request.pathname === root && isDesktopSession(
      { hostId: this.hostId, pathname: this.routePathname, params: this.routeParams })) ? root : this.routePathname;
    return BridgeHost.classifyRoute(pathname, manifest, (grant: string): boolean =>
      ['fault', 'externalLink', 'externalNavigation', 'haptics'].includes(grant)
      || (!this.asDrawer && grant === 'terminalKeyRail') || BridgeHost.supportsCoreGrant(grant, NATIVE_DEVICE_METHODS));
  }

  private readWorkingBundle(meta: HostMeta, status?: DesktopBundleStatus): CachedWebBundle | null {
    if (this.asDrawer) { return null; }
    let cached = WebBundleFetcher.readPairedBundle(getContext(this), meta.id, meta.lastConnected);
    if (!cached || this.routeAdmission(cached.manifest)) { return null; }
    try {
      if (status) { WebBundleFetcher.requireCompatibility(status, cached.manifest); }
      return cached;
    } catch (e) { return null; }
  }

  private async openConnectedBundle(client: SpikeRpcClient, meta: HostMeta, status?: DesktopBundleStatus): Promise<void> {
    let generation = ++this.generation; this.releaseBridge(); this.client = client;
    this.painted = false; this.desktopName = meta.name; this.startupGeneration = this.startup.begin();
    let current = (): boolean => !this.disposed && generation === this.generation && this.client === client;
    let context = getContext(this);
    let fetcher = new WebBundleFetcher(client, context);
    try {
      this.publishPhase('已连接 · 加载会话…', 'checking');
      let facts = status ?? await fetcher.fetchDesktopStatus();
      if (!current()) { return; }
      let fallback = this.readWorkingBundle(meta, facts);
      let manifest: BundleManifest;
      try { manifest = await fetcher.fetchManifest(facts); }
      catch (e) {
        if (!current()) { return; }
        if (!fallback) { throw e as Error; }
        this.mountBundle(client, meta, fallback.manifest, fallback.directory, generation);
        if (!(e instanceof BundleCompatibilityError)) { this.reportUpdateFailure('manifest'); }
        return;
      }
      if (!current()) { return; }
      this.requireRoute(this.routeAdmission(manifest));
      let completed = fetcher.completedDirectory(manifest);
      if (fallback && !completed) {
        this.mountBundle(client, meta, fallback.manifest, fallback.directory, generation);
        this.stageUpdate(client, this.document!, facts, manifest).catch(() => {});
        return;
      }
      let startupGeneration = this.startupGeneration;
      let baseDir = completed ?? await fetcher.ensureBundle(manifest, (received: number, total: number): void => {
        if (!current()) { return; }
        this.startup.progress(startupGeneration);
        if (total > 0) {
          this.stage = 'downloading';
          this.downloadPercent = Math.floor(received * 100 / total);
          this.downloadCaption = `${(received / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB`;
        }
      });
      if (!current()) { return; }
      this.startup.progress(startupGeneration);
      this.downloadPercent = -1;
      if (fallback && fallback.directory !== baseDir) {
        this.activationFallback = { bundle: fallback, pathname: this.routePathname, params: this.routeParams, target: this.pendingSession };
      }
      this.mountBundle(client, meta, manifest, baseDir, generation);
    } catch (e) {
      if (current()) { this.handleStartupFailure(e); }
    }
  }

  private async stageUpdate(client: SpikeRpcClient, document: ShellDocument, status: DesktopBundleStatus,
    offered?: BundleManifest): Promise<void> {
    if (this.asDrawer) { return; }
    let current = (): boolean => !this.disposed && this.client === client && this.document === document
      && this.desktop?.connection.getClient() === client && client.getState() === 'ready';
    let context = getContext(this);
    let fetcher = new WebBundleFetcher(client, context);
    try {
      let manifest = offered ?? await fetcher.fetchManifest(status);
      if (!current() || JSON.stringify(manifest) === JSON.stringify(document.manifest)) { return; }
      await fetcher.ensureBundle(manifest);
      if (!current()) { return; }
      this.updateFailed = false;
      recordConnection(context, LOG_LEVEL_INFO, '新版工作区已准备好，下次进入时打开', '',
        this.hostId, 'web-shell-update-staged').catch(() => {});
    } catch (e) {
      if (current() && !(e instanceof BundleCompatibilityError)) { this.reportUpdateFailure('download'); }
    }
  }

  private openCachedBundle(meta: HostMeta): void {
    if (this.asDrawer || this.bridge || this.triedCachedBundle || this.disposed) { return; }
    this.triedCachedBundle = true;
    let cached = this.readWorkingBundle(meta);
    if (!cached) { return; }
    let generation = ++this.generation;
    this.cacheOnly = true;
    this.startupGeneration = this.startup.begin();
    try {
      this.mountBundle(null, meta, cached.manifest, cached.directory, generation);
      recordConnection(getContext(this), LOG_LEVEL_INFO, '已离线打开缓存页面', '', meta.id, 'web-shell-flow').catch(() => {});
    } catch (e) {
      if (e instanceof BundleCompatibilityError) {
        this.startup.cancel(); this.generation++; this.releaseBridge();
        this.publishPhase('连接中断', 'offline');
      } else { this.failStartup('会话加载未完成，请重试'); }
    }
  }

  private async reattachDocument(client: SpikeRpcClient, meta: HostMeta, document: ShellDocument): Promise<void> {
    if (this.attachingClient === client || this.client === client) { return; }
    this.attachingClient = client;
    let current = (): boolean => !this.disposed && this.document === document && this.attachingClient === client
      && this.desktop?.connection.getClient() === client;
    try {
      let fetcher = new WebBundleFetcher(client, getContext(this));
      let status = await fetcher.fetchDesktopStatus();
      if (!current()) { return; }
      try { WebBundleFetcher.requireCompatibility(status, document.manifest); }
      catch (e) {
        // An offline document has yet to talk to this desktop. Let its current manifest decide.
        if (this.cacheOnly && e instanceof BundleCompatibilityError) {
          await this.openConnectedBundle(client, meta, status);
          return;
        }
        throw e as Error;
      }
      this.cacheOnly = false; this.client = client;
      this.nativeDevice?.setDesktopClient(client);
      this.bridge?.attachTransport(client, this.desktop?.connection.getActivePath() ?? 'lan');
      if (this.painted) { this.publishPhase('已连接', 'ready'); this.openPendingNativeSession(); }
      this.stageUpdate(client, document, status).catch(() => {});
    } catch (e) {
      if (current() && e instanceof BundleCompatibilityError) { this.handleStartupFailure(e); }
    } finally {
      if (this.attachingClient === client) { this.attachingClient = null; }
    }
  }

  private requireRoute(block: string): void {
    if (block === 'desktop') { throw new BundleCompatibilityError('desktop', 'page-route-unlisted'); }
    if (block === 'mobile') { throw new BundleCompatibilityError('mobile', 'page-route-grant-missing'); }
  }

  private mountBundle(client: SpikeRpcClient | null, meta: HostMeta, manifest: BundleManifest, baseDir: string,
    generation: number): void {
      let path = this.desktop?.connection.getActivePath() ?? 'lan';
    let warm = claimHomeDocument(meta.id, baseDir);
    let document = warm ?? new ShellDocument(manifest, baseDir, false);
    this.document = document;
    let storage = new PageStorageStore(getContext(this), meta.id);
    let nativeDevice = new NativeDevice(getContext(this) as common.UIAbilityContext, client); this.nativeDevice = nativeDevice;
    let root = desktopPath(meta.id);
    let shown: ShellRoute = { hostId: meta.id, pathname: this.routePathname, params: this.routeParams };
    if (!this.pendingSession && this.request.pathname === root && isDesktopSession(shown)) { this.pendingSession = shown; }
    let target = this.pendingSession;
    let entry = target ? root : shown.pathname;
    let bridge = new BridgeHost(client, document.controller, manifest, meta, entry, path);
    bridge.setWideLayout(this.surface.width >= 700 && this.surface.height >= 600);
    bridge.setStorage(storage); bridge.setColorScheme(this.scheme); bridge.setUiLocale(this.uiLocale);
    if (!this.asDrawer) {
      bridge.setTerminalRailClaimSink((claim: TerminalRailClaim | null): void => {
        if (this.bridge === bridge) { this.railClaim = claim; this.publishPageRegions(); }
      });
    }
    if (this.returnsToDesktop) { bridge.setDesktopListBack(); }
    bridge.setLivenessSink((): void => {
      if (!this.pageVisible || !this.foreground || this.bridge !== bridge) { return; }
      let connected = this.desktop?.connection.getClient();
      if (!this.client && connected) { this.reattachDocument(connected, meta, document).catch(() => {}); }
      else { this.desktop?.connection.revive(); }
    });
    bridge.setLocationSink((pathname: string, params: Record<string, string>): void => this.recordResume(pathname, params));
    bridge.setNativeNavigation((page: BridgeNativePage, replace: boolean): void => {
      if (this.disposed || !this.pageVisible || !this.foreground || this.bridge !== bridge) { return; }
      let url = page === 'edit-host' ? 'pages/HostDetail' : 'pages/ConnectionLog';
      let params: Record<string, string> = { 'hostId': meta.id };
      let navigation = replace ? router.replaceUrl({ url: url, params: params }) : router.pushUrl({ url: url, params: params });
      navigation.catch(() => {});
    });
    bridge.setShellNavigation((pathname: string, params: Record<string, string>, replace: boolean): void => {
      if (this.disposed || !this.pageVisible || !this.foreground || this.bridge !== bridge) { return; }
      this.onNativeRoute({ hostId: meta.id, pathname: pathname, params: params }, replace);
    });
    this.recordResume(this.routePathname, this.routeParams);
    bridge.setDeviceNotifies((target: string): Promise<void> => nativeDevice.notifyExternalLink(target),
      (kind: string): Promise<void> => nativeDevice.notifyHaptic(kind), true);
    bridge.setNativeHandler(nativeDevice.methods, (method: string, params: ESObject): Promise<Object> => nativeDevice.serve(method, params));
    bridge.setNavigation((home: boolean): void => this.navigateBack(home), (): void => this.pagePainted(meta, document, generation));
    if (this.asDrawer) {
      bridge.setOverlayNavigation((pathname: string, params: Record<string, string>): void => {
        if (this.bridge === bridge) { this.openOverlayRoute(pathname, params); }
      });
    }
    bridge.setFaultSink((_message: string): void => this.failStartup('会话页面发生错误，请重试'));
    this.bridge = bridge;
    this.requireRoute(bridge.routeBlock(entry));
    let open = target && bridge.ownsHostArea(root) && !bridge.routeBlock(target.pathname)
      ? sessionOpenParam(target, manifest.pageVersion) : '';
    this.opensSessionNatively = target !== null && open === '';
    bridge.setRouteParams(open ? { 'open': open } : target ? {} : shown.params);
    this.publishKeyboardInset();
    this.publishPageRegions();
    document.onReady = (): void => {};
    document.allowExternal = (): boolean => this.pageVisible && this.foreground && this.document === document;
    document.onLoaded = (): void => {
      if (this.document === document && !this.painted) { this.publishPhase('页面已加载，正在初始化…', 'opening'); }
    };
    document.onFailure = (message: string): void => { if (this.document === document) { this.failStartup(message); } };
    this.publishPhase('正在打开会话…', 'opening');
    document.bind(bridge, this.asDrawer);
    document.prepare(this.getUIContext());
    this.documentMount.setDocument(document);
    document.activate();
    if (warm) {
      recordConnection(getContext(this), LOG_LEVEL_INFO, '已复用预热页面', '', meta.id, 'web-shell-flow').catch(() => {});
    }
  }

  private t(label: string): string { return uiText(label, this.uiLocale); }

  private waitingLabel(): string {
    if (this.stage === 'downloading') { return this.t('正在下载最新版本的应用'); }
    if (this.stage === 'opening') { return this.t('正在打开工作区'); }
    if (this.stage === 'offline') { return this.t('连接到此主机以下载最新版本的应用'); }
    if (this.stage === 'repair') { return this.t('凭证已失效，请重新配对'); }
    if (this.stage === 'failed') { return this.t(this.failureMessage); }
    return this.t('正在检查主机');
  }

  @Builder
  private startupScreen() {
    Stack({ alignContent: Alignment.TopStart }) {
      Column({ space: 8 }) {
        if (this.stage === 'downloading') {
          Progress({ value: this.downloadPercent, total: 100, type: ProgressType.Linear })
            .width('100%').constraintSize({ maxWidth: 240 }).color(this.themeText).backgroundColor(this.themeBorder)
            .accessibilityText(this.waitingLabel())
        } else if (this.stage === 'checking' || this.stage === 'opening') {
          LoadingProgress().width(20).height(20).color(this.themeSecondary)
        }
        Text(this.waitingLabel()).fontFamily('Geist').fontSize(14).fontColor(this.themeSecondary)
          .textAlign(TextAlign.Center).margin({ top: 4 })
        if (this.stage === 'downloading') {
          Text(this.t('来自 {{desktop}} · {{size}}').replace('{{desktop}}', this.desktopName).replace('{{size}}', this.downloadCaption))
            .fontFamily('Geist').fontSize(12).fontColor(this.themeMuted).textAlign(TextAlign.Center)
        }
        if (this.stage === 'failed' || this.stage === 'offline' || this.stage === 'repair') {
          Button(this.t(this.stage === 'repair' ? '重新配对' : '重试'), { type: ButtonType.Normal })
            .fontFamily('Geist').fontSize(14).fontWeight(FontWeight.Medium).fontColor(this.themeText)
            .backgroundColor(this.themeSurface).borderRadius(12).constraintSize({ minHeight: 40 })
            .padding({ left: 16, right: 16 }).margin({ top: 8 })
            .onClick((): void => {
              if (this.stage === 'repair') {
                router.pushUrl({ url: 'pages/PairScan', params: { 'repairHostId': this.hostId } }).catch(() => {});
              }
              else { this.retryStartup(); }
            })
          Button(this.t('网络诊断'), { type: ButtonType.Normal }).fontFamily('Geist').fontSize(14)
            .fontColor(this.themeSecondary).backgroundColor(Color.Transparent).constraintSize({ minHeight: 40 })
            .onClick((): void => {
              router.pushUrl({ url: 'pages/ConnectionLog', params: { 'hostId': this.hostId } }).catch(() => {});
            })
        }
      }.width('100%').height('100%').justifyContent(FlexAlign.Center).padding({ left: 16, right: 16 })

      Button({ type: ButtonType.Normal }) {
        Image($r('app.media.lucide_chevron_left')).width(22).height(22).supportSvg2(true)
          .colorFilter(lucideColorFilter(this.themeSecondary))
      }.width(36).height(36).borderRadius(12).backgroundColor(Color.Transparent).margin({ left: 16, top: 8 })
        .accessibilityText(this.t('返回')).onClick((): void => this.navigateBack())
    }.width('100%').height('100%').backgroundColor(this.themeBg)
  }

  @Builder
  private overlayLoadingDrawer() {
    Stack({ alignContent: Alignment.Bottom }) {
      Column().width('100%').height('100%').backgroundColor('rgba(0,0,0,0.55)')
        .accessibilityText(uiText('取消', this.uiLocale)).onClick(() => this.onOverlayClose())
      Column({ space: 12 }) {
        Row().width(36).height(5).borderRadius(3).backgroundColor(this.themeMuted).opacity(0.5)
        Column({ space: 8 }) {
          if (this.downloadPercent >= 0) {
            Progress({ value: this.downloadPercent, total: 100, type: ProgressType.Linear })
              .width('100%').color(this.themeText).backgroundColor(this.themeBorder)
            Text(uiText('正在下载… {{progress}}', this.uiLocale).replace('{{progress}}', this.downloadCaption))
              .fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
          } else {
            LoadingProgress().width(24).height(24).color(this.themeSecondary).accessibilityText(uiText('正在加载…', this.uiLocale))
          }
        }.width('100%').height(96).justifyContent(FlexAlign.Center)
      }.width('100%').constraintSize({ maxWidth: this.wideDrawer ? 480 : '100%' })
        .padding({ left: 16, right: 16, top: 8, bottom: 16 })
        .backgroundColor(this.themeSheet).borderRadius({ topLeft: 24, topRight: 24 })
        .gesture(PanGesture({ direction: PanDirection.Down, distance: 40 }).onActionEnd(() => this.onOverlayClose()))
    }.width('100%').height('100%')
  }

  @Builder
  private updateNotice() {
    Row({ space: 12 }) {
      Text(this.t('无法加载此桌面的最新工作区，正在显示上次可用版本。')).fontFamily('Geist')
        .fontSize(13).fontColor(this.themeSecondary).layoutWeight(1)
      Button({ type: ButtonType.Normal }) {
        Image($r('app.media.lucide_x')).width(16).height(16).supportSvg2(true)
          .colorFilter(lucideColorFilter(this.themeMuted))
      }.width(44).height(44).backgroundColor(Color.Transparent)
        .accessibilityText(this.t('关闭提示')).onClick((): void => { this.updateFailed = false; })
    }.width('100%').padding({ left: 16, right: 8 }).backgroundColor(this.themeSurface)
      .border({ width: { bottom: 1 }, color: this.themeStatusRed })
  }

  @Builder
  private pageSurface() {
    Stack({ alignContent: Alignment.TopStart }) {
      Row() {
        if (this.sideRail?.side === 'left') { Blank().width(this.sideRail.width) }
        NodeContainer(this.documentMount).layoutWeight(1).height('100%')
        .backgroundColor(this.asDrawer ? Color.Transparent : this.themeBg)
        .accessibilityLevel(this.painted ? 'auto' : 'no-hide-descendants')
        .opacity(this.asDrawer && !this.painted ? 0 : 1)
        .onAreaChange((_previous: Area, area: Area): void => {
          this.viewport = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y),
            width: Number(area.width), height: Number(area.height) };
          if (this.asDrawer) { this.wideDrawer = this.viewport.width >= 700 && this.viewport.height >= 600; }
          this.publishWindowLayout();
        })
        if (this.sideRail?.side === 'right') { Blank().width(this.sideRail.width) }
      }.width('100%').height('100%')
        .onAreaChange((_previous: Area, area: Area): void => {
          this.surface = { x: Number(area.globalPosition.x), y: Number(area.globalPosition.y),
            width: Number(area.width), height: Number(area.height) };
          this.publishPageRegions();
        })
      if (this.sideRail && this.railKeys.length > 0 && this.railClaim) {
        TerminalKeyRail({ strip: this.sideRail, claim: this.railClaim, keys: this.railKeys, hasPad: this.directionPadAvailable,
          onKey: (owner: string, key: string): Promise<boolean> =>
            this.bridge?.sendTerminalRailKey(owner, key) ?? Promise.resolve(false) })
          .position({ x: this.sideRail.side === 'left' ? 0 : this.surface.width - this.sideRail.width, y: this.sideRail.top })
      }
      // Keep the viewport fixed through first paint and transport recovery.
      if (!this.painted) {
        if (this.stage === 'incompatible') {
          BundleCompatibilityCard({ remedy: this.bundleRemedy, onBack: (): void => this.navigateBack(true) })
        } else if (this.asDrawer) { this.overlayLoadingDrawer() }
        else { this.startupScreen() }
      }
    }.width('100%').layoutWeight(1).backgroundColor(this.asDrawer ? Color.Transparent : this.themeBg)
  }

  build() {
    Column() {
      if (!this.asDrawer && this.painted && this.updateFailed) { this.updateNotice() }
      this.pageSurface()
    }.width('100%').height('100%')
  }
}
