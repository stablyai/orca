import { uiText } from '../settings/NativeUi';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { readHomeResume, saveHomeResume, resumeFromLocation } from '../home/HomeResume';
import { NativeDevice } from './NativeDevice';
import { PageStorageStore } from '../storage/PageStorageStore';
import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { WebBundleFetcher } from '../transport/WebBundleFetcher';
import { ShellStartup } from './ShellStartup';
import { ShellDocument, ShellDocumentMount } from './ShellDocument';
import { claimHomeDocument } from './HomeShellPrewarm';
import { BridgeHost, BridgeNativePage } from './BridgeHost';
import { HostMeta } from '../storage/HostStore';
import { desktopPath, isDesktopSession, sessionOpenParam, ShellRoute } from '../navigation/ShellRoute';
import { lucideColorFilter } from '../settings/LucideColor';

type ShellStage = 'checking' | 'downloading' | 'opening' | 'offline' | 'repair' | 'failed' | 'ready';

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
  onOverlayClose: () => void = (): void => {};
  onOverlayNavigate: (route: ShellRoute) => void = (_route: ShellRoute): void => {};
  private unbindBack: (() => void) | null = null;
  @StorageProp('uiLocale') @Watch('onLocaleChanged') uiLocale: string = 'en';
  @StorageProp('themeScheme') @Watch('onThemeChanged') scheme: string = 'dark';
  @StorageProp('shellKeyboardTop') @Watch('publishKeyboardInset') keyboardTop: number = -1;
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#171717';
  @StorageProp('themeSheet') themeSheet: string = '#171717';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  private document: ShellDocument | null = null;
  private documentMount: ShellDocumentMount = new ShellDocumentMount();
  private bridge: BridgeHost | null = null;
  private client: SpikeRpcClient | null = null;
  private hostId: string = '';
  private phase: string = '';
  @State stage: ShellStage = 'checking';
  @State failureMessage: string = '';
  @State desktopName: string = '';
  @State downloadPercent: number = -1;
  @State downloadCaption: string = '';
  @State wideDrawer: boolean = false;
  @State painted: boolean = false;
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
  private viewportTop: number = 0;
  private viewportHeight: number = 0;
  private pendingDrawerRoute: ShellRoute | null = null;
  private pendingSession: ShellRoute | null = null;
  private opensSessionNatively: boolean = false;
  private foregroundListener: () => void = (): void => {
    this.foreground = true; this.publishKeyboardInset(); this.updateViewing();
    this.flushDrawerRoute();
    this.openPendingNativeSession();
  };
  private generation: number = 0;
  private backgroundListener: () => void = (): void => {
    this.foreground = false; this.clearViewing();
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
    if (this.pageVisible) { this.publishKeyboardInset(); this.updateViewing(); this.flushDrawerRoute(); }
    else {
      this.pendingSession = null;
      this.clearViewing();
      this.nativeDevice?.pause().catch(() => {});
    }
  }

  private openPendingNativeSession(): void {
    let target = this.pendingSession;
    if (!target || !this.opensSessionNatively || !this.painted || !this.pageVisible || !this.foreground || this.disposed) { return; }
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
    let covered = this.keyboardTop < 0 ? 0 : this.viewportTop + this.viewportHeight - this.keyboardTop;
    this.bridge.setKeyboardInset(Math.max(0, Math.min(this.viewportHeight, covered)));
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
    this.downloadPercent = -1; this.downloadCaption = '';
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
    this.startup.cancel(); this.generation++;
    if (!this.painted || !this.bridge) { this.releaseBridge(); return; }
    this.client = null;
    this.nativeDevice?.setDesktopClient(null);
    this.bridge.suspendTransport(attempt);
  }
  private failStartup(message: string): void {
    if (this.disposed) { return; }
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

  private pagePainted(client: SpikeRpcClient, generation: number): void {
    if (this.disposed || generation !== this.generation || this.client !== client) { return; }
    if (this.startup.complete(this.startupGeneration)) {
      this.painted = true; this.publishPhase('已连接', 'ready'); this.updateViewing();
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
        let meta = desktop.connection.getMeta();
        if (client && meta && client !== this.client) { this.loadConnected(client, meta).catch(() => {}); }
      } else if (phase === 'reconnecting' || phase === 'connecting') {
        if (this.client || this.bridge) { this.suspendTransport(desktop.connection.getReconnectAttempt()); }
        this.publishPhase(phase === 'connecting' ? '连接桌面…' : `连接中断 · ${detail}`,
          phase === 'connecting' ? 'checking' : 'offline');
      } else if (phase === 'auth-failed') {
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
    let meta = connection.getMeta();
    if (client && meta) { this.loadConnected(client, meta).catch(() => {}); }
    else { connection.reconnect(); }
  }

  private async loadConnected(client: SpikeRpcClient, meta: HostMeta): Promise<void> {
    let path = this.desktop?.connection.getActivePath() ?? 'lan';
    if (this.painted && this.bridge && this.nativeDevice) {
      this.client = client;
      this.nativeDevice.setDesktopClient(client);
      this.bridge.attachTransport(client, path);
      this.publishPhase('已连接', 'ready');
      return;
    }
    let generation = ++this.generation; this.releaseBridge(); this.client = client;
    this.painted = false; this.desktopName = meta.name; this.startupGeneration = this.startup.begin();
    try {
      this.publishPhase('已连接 · 加载会话…', 'checking');
      let fetcher = new WebBundleFetcher(client, getContext(this));
      let manifest = await fetcher.fetchManifest();
      if (this.disposed || generation !== this.generation || this.client !== client) { return; }
      if (this.asDrawer && !manifest.routes.some((route): boolean => route.pathname === '/h/[hostId]/new-workspace')) {
        this.failStartup('桌面未提供新建工作区页面'); return;
      }
      let startupGeneration = this.startupGeneration;
      let baseDir = await fetcher.ensureBundle(manifest, (received: number, total: number): void => {
        if (this.disposed || generation !== this.generation || this.client !== client) { return; }
        this.startup.progress(startupGeneration);
        if (total > 0) {
          this.stage = 'downloading';
          this.downloadPercent = Math.floor(received * 100 / total);
          this.downloadCaption = `${(received / 1_000_000).toFixed(1)} / ${(total / 1_000_000).toFixed(1)} MB`;
        }
      });
      if (this.disposed || generation !== this.generation || this.client !== client) { return; }
      this.startup.progress(startupGeneration);
      this.downloadPercent = -1;
      let warm = claimHomeDocument(meta.id, baseDir);
      let document = warm ?? new ShellDocument(manifest, baseDir, false);
      this.document = document;
      let storage = new PageStorageStore(getContext(this), meta.id);
      let nativeDevice = new NativeDevice(getContext(this) as common.UIAbilityContext, client); this.nativeDevice = nativeDevice;
      let root = desktopPath(meta.id);
      let shown: ShellRoute = { hostId: meta.id, pathname: this.routePathname, params: this.routeParams };
      if (!this.pendingSession && this.request.pathname === root && isDesktopSession(shown)) { this.pendingSession = shown; }
      let target = this.pendingSession;
      let open = target && manifest.routes.some((route): boolean => route.pathname === '/h/[hostId]' && route.canOwnHostArea)
        ? sessionOpenParam(target, manifest.pageVersion) : '';
      this.opensSessionNatively = target !== null && open === '';
      let params: Record<string, string> = open ? { 'open': open } : target ? {} : shown.params;
      let bridge = new BridgeHost(client, document.controller, manifest, meta, target ? root : shown.pathname, path);
      bridge.setStorage(storage); bridge.setColorScheme(this.scheme); bridge.setUiLocale(this.uiLocale); bridge.setRouteParams(params);
      if (this.returnsToDesktop) { bridge.setDesktopListBack(); }
      bridge.setLivenessSink((): void => {
        if (this.pageVisible && this.foreground && this.bridge === bridge) { this.desktop?.connection.revive(); }
      });
      bridge.setLocationSink((pathname: string, params: Record<string, string>): void => this.recordResume(pathname, params));
      bridge.setNativeNavigation((page: BridgeNativePage, replace: boolean): void => {
        if (this.disposed || !this.pageVisible || !this.foreground || this.bridge !== bridge) { return; }
        let url = page === 'edit-host' ? 'pages/HostDetail' : 'pages/ConnectionLog';
        let params: Record<string, string> = { 'hostId': meta.id };
        let navigation = replace ? router.replaceUrl({ url: url, params: params }) : router.pushUrl({ url: url, params: params });
        navigation.catch(() => {});
      });
      this.recordResume(this.routePathname, this.routeParams);
      bridge.setDeviceNotifies((target: string): Promise<void> => nativeDevice.notifyExternalLink(target),
        (kind: string): Promise<void> => nativeDevice.notifyHaptic(kind), true);
      bridge.setNativeHandler(nativeDevice.methods, (method: string, params: ESObject): Promise<Object> => nativeDevice.serve(method, params));
      bridge.setNavigation((home: boolean): void => this.navigateBack(home), (): void => this.pagePainted(client, generation));
      if (this.asDrawer) {
        bridge.setOverlayNavigation((pathname: string, params: Record<string, string>): void => {
          if (this.bridge === bridge) { this.openOverlayRoute(pathname, params); }
        });
      }
      bridge.setFaultSink((_message: string): void => this.failStartup('会话页面发生错误，请重试'));
      this.bridge = bridge;
      this.publishKeyboardInset();
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
    } catch (e) {
      if (!this.disposed && generation === this.generation) { this.failStartup('会话加载未完成，请重试'); }
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

  build() {
    Stack() {
      NodeContainer(this.documentMount).width('100%').height('100%')
        .backgroundColor(this.asDrawer ? Color.Transparent : this.themeBg)
        .accessibilityLevel(this.painted ? 'auto' : 'no-hide-descendants')
        .opacity(this.asDrawer && !this.painted ? 0 : 1)
        .onAreaChange((_previous: Area, area: Area): void => {
          this.viewportTop = Number(area.globalPosition.y); this.viewportHeight = Number(area.height);
          if (this.asDrawer) { this.wideDrawer = Number(area.width) >= 700 && this.viewportHeight >= 600; }
          this.publishKeyboardInset();
        })
      // Keep the viewport fixed through first paint and transport recovery.
      if (!this.painted) {
        if (this.asDrawer) { this.overlayLoadingDrawer() }
        else { this.startupScreen() }
      }
    }.width('100%').height('100%').backgroundColor(this.asDrawer ? Color.Transparent : this.themeBg)
  }
}
