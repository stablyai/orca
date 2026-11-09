import { uiText } from '../settings/NativeUi';
import { SessionPhase } from '../transport/HostSession';
import { DesktopConnectionLease, retainDesktopConnection } from '../transport/DesktopConnections';
import { readHomeResume, saveHomeResume, resumeFromLocation } from '../home/HomeResume';
import { NativeDevice } from '../webshell/NativeDevice';
import { PageStorageStore } from '../storage/PageStorageStore';
import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { common } from '@kit.AbilityKit';
import { router } from '@kit.ArkUI';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { WebBundleFetcher } from '../transport/WebBundleFetcher';
import { ShellStartup } from '../webshell/ShellStartup';
import { ShellDocument, ShellDocumentMount } from '../webshell/ShellDocument';
import { claimHomeDocument } from '../webshell/HomeShellPrewarm';
import { BridgeHost, BridgeNativePage } from '../webshell/BridgeHost';
import { HostMeta } from '../storage/HostStore';

@Entry
@Component
struct ShellScreen {
  @StorageProp('uiLocale') @Watch('onLocaleChanged') uiLocale: string = 'en';
  @StorageProp('themeScheme') @Watch('onThemeChanged') scheme: string = 'dark';
  @StorageProp('themeBg') themeBg: string = '#111111';
  @StorageProp('themeSurface') themeSurface: string = '#1c1c1c';
  @StorageProp('themeBorder') themeBorder: string = '#353a42';
  @StorageProp('themeText') themeText: string = '#e8e8e8';
  @StorageProp('themeMuted') themeMuted: string = '#a3a9b2';
  @StorageProp('themeSecondary') themeSecondary: string = '#b5bec9';
  @StorageProp('themeAccent') themeAccent: string = '#7ddf7d';
  @StorageProp('themeLink') themeLink: string = '#96b8e5';
  @StorageProp('themeWarning') themeWarning: string = '#e0c070';
  private document: ShellDocument | null = null;
  private documentMount: ShellDocumentMount = new ShellDocumentMount();
  private bridge: BridgeHost | null = null;
  private client: SpikeRpcClient | null = null;
  private hostId: string = '';
  @State phase: string = '启动中…';
  @State downloadPercent: number = -1;
  @State logs: string[] = [];
  @State hasDocument: boolean = false;
  @State showLog: boolean = false;
  private startup: ShellStartup = new ShellStartup((message: string): void => this.failStartup(message));
  private startupGeneration: number = 0;
  private painted: boolean = false;
  private routePathname: string = '';
  private routeParams: Record<string, string> = {};
  private desktop: DesktopConnectionLease | null = null;
  private unobserveDesktop: (() => void) | null = null;
  private viewingOwner: Object = new Object();
  private nativeDevice: NativeDevice | null = null;
  private disposed: boolean = false;
  private pageVisible: boolean = true;
  private foreground: boolean = true;
  private foregroundListener: () => void = (): void => {
    this.foreground = true; this.updateViewing();
  };
  private generation: number = 0;
  private backgroundListener: () => void = (): void => {
    this.foreground = false; this.clearViewing();
    if (this.nativeDevice) { this.nativeDevice.pause().catch(() => {}); }
  };

  appendLog(line: string): void {
    let stamped = `${new Date().toLocaleTimeString()}  ${line}`;
    let next = this.logs.slice();
    next.push(stamped);
    if (next.length > 120) {
      next.splice(0, next.length - 120);
    }
    this.logs = next;
  }

  aboutToAppear(): void {
    let params = (router.getParams() ?? {}) as Record<string, string>;
    this.hostId = params['hostId'];
    let routeKeys = ['paneKey', 'executionHost', 'new'];
    for (let i = 0; i < routeKeys.length; i++) {
      let key = routeKeys[i];
      if (typeof params[key] === 'string' && params[key].length > 0) { this.routeParams[key] = params[key]; }
    }
    let routeOverride = params['route'];
    this.routePathname = (routeOverride !== undefined && routeOverride.length > 0)
      ? routeOverride
      : `/h/${this.hostId}`;
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
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaBackground', this.backgroundListener);
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaForeground', this.foregroundListener);
    this.clearViewing();
    this.unobserveDesktop?.(); this.unobserveDesktop = null;
    this.desktop?.release(true); this.desktop = null;
    this.releaseBridge();
  }
  onBackPress(): boolean {
    if (this.showLog) { this.showLog = false; return true; }
    return this.bridge ? this.bridge.handleBack() : false;
  }
  onPageShow(): void {
    this.pageVisible = true; this.updateViewing();
  }
  onPageHide(): void {
    this.pageVisible = false; this.clearViewing();
    if (this.nativeDevice) { this.nativeDevice.pause().catch(() => {}); }
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
    this.downloadPercent = -1;
    if (this.bridge) {
      this.routePathname = this.bridge.getRoute();
      this.routeParams = this.bridge.getRouteParams();
      this.recordResume(this.routePathname, this.routeParams);
      this.bridge.publishState('disconnected', 0); this.bridge.dispose(); this.bridge = null;
    }
    let document = this.document; this.document = null;
    if (document) { this.documentMount.setDocument(null); document.dispose(); }
    this.hasDocument = false; this.clearViewing();
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
    this.publishPhase(`失败：${message}`);
  }

  private pagePainted(client: SpikeRpcClient, generation: number): void {
    if (this.disposed || generation !== this.generation || this.client !== client) { return; }
    if (this.startup.complete(this.startupGeneration)) {
      this.painted = true; this.publishPhase('已连接'); this.updateViewing();
    }
  }

  private publishPhase(state: string): void {
    if (this.disposed || this.phase === state) { return; }
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
        this.publishPhase(phase === 'connecting' ? '连接桌面…' : `连接中断 · ${detail}`);
      } else if (phase === 'auth-failed') {
        this.startup.cancel(); this.generation++; this.releaseBridge();
        this.publishPhase('凭证已失效，请重新配对'); this.painted = false;
      } else if (phase === 'stopped') {
        if (this.client || this.bridge) { this.suspendTransport(0); }
        this.publishPhase(detail === '已断开' ? detail : `失败：${detail}`);
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
      this.publishPhase('已连接');
      return;
    }
    let generation = ++this.generation; this.releaseBridge(); this.client = client;
    this.painted = false; this.startupGeneration = this.startup.begin();
    try {
      this.publishPhase('已连接 · 加载会话…');
      let fetcher = new WebBundleFetcher(client, getContext(this));
      let manifest = await fetcher.fetchManifest();
      if (this.disposed || generation !== this.generation || this.client !== client) { return; }
      let startupGeneration = this.startupGeneration;
      let baseDir = await fetcher.ensureBundle(manifest, (received: number, total: number): void => {
        if (this.disposed || generation !== this.generation || this.client !== client) { return; }
        this.startup.progress(startupGeneration);
        if (total > 0) { this.downloadPercent = Math.floor(received * 100 / total); }
      });
      if (this.disposed || generation !== this.generation || this.client !== client) { return; }
      this.startup.progress(startupGeneration);
      this.downloadPercent = -1;
      let warm = claimHomeDocument(meta.id, baseDir);
      let document = warm ?? new ShellDocument(manifest, baseDir, false);
      this.document = document;
      let storage = new PageStorageStore(getContext(this), meta.id);
      let nativeDevice = new NativeDevice(getContext(this) as common.UIAbilityContext, client); this.nativeDevice = nativeDevice;
      let bridge = new BridgeHost(client, document.controller, manifest, meta, this.routePathname, path);
      bridge.setStorage(storage); bridge.setColorScheme(this.scheme); bridge.setUiLocale(this.uiLocale); bridge.setRouteParams(this.routeParams);
      bridge.setLivenessSink((): void => {
        if (this.pageVisible && this.foreground && this.bridge === bridge) { this.desktop?.connection.revive(); }
      });
      bridge.setLocationSink((pathname: string, params: Record<string, string>): void => this.recordResume(pathname, params));
      bridge.setNativeNavigation((page: BridgeNativePage, replace: boolean): void => {
        if (this.disposed || !this.pageVisible || this.bridge !== bridge) { return; }
        let url = page === 'edit-host' ? 'pages/HostDetail' : 'pages/ConnectionLog';
        let params: Record<string, string> = { 'hostId': meta.id };
        let navigation = replace ? router.replaceUrl({ url: url, params: params }) : router.pushUrl({ url: url, params: params });
        navigation.catch(() => { this.appendLog('Could not open the native screen'); });
      });
      this.recordResume(this.routePathname, this.routeParams);
      bridge.setDeviceNotifies((target: string): Promise<void> => nativeDevice.notifyExternalLink(target),
        (kind: string): Promise<void> => nativeDevice.notifyHaptic(kind), true);
      bridge.setNativeHandler(nativeDevice.methods, (method: string, params: ESObject): Promise<Object> => nativeDevice.serve(method, params));
      bridge.setNavigation((home: boolean): void => { if (home) { router.back({ url: 'pages/Home' }); } else { router.back(); } }, (): void => this.pagePainted(client, generation));
      bridge.setFaultSink((_message: string): void => this.failStartup('会话页面发生错误，请重试'));
      bridge.setLogSink((line: string): void => this.appendLog(line));
      this.bridge = bridge;
      document.onReady = (): void => {};
      document.allowExternal = (): boolean => this.pageVisible && this.foreground && this.document === document;
      document.onLoaded = (): void => {
        if (this.document === document && !this.painted) { this.publishPhase('页面已加载，正在初始化…'); }
      };
      document.onFailure = (message: string): void => { if (this.document === document) { this.failStartup(message); } };
      this.publishPhase('正在打开会话…');
      document.bind(bridge);
      document.prepare(this.getUIContext());
      this.documentMount.setDocument(document);
      document.activate();
      this.hasDocument = true;
      if (warm) {
        recordConnection(getContext(this), LOG_LEVEL_INFO, '已复用预热页面', '', meta.id, 'web-shell-flow').catch(() => {});
      }
    } catch (e) {
      if (!this.disposed && generation === this.generation) { this.failStartup('会话加载未完成，请重试'); }
    }
  }

  build() {
    Column() {
      if (!this.hasDocument || this.phase !== '已连接' || this.showLog) {
      Row({ space: 10 }) {
        Button(uiText('返回', this.uiLocale)).fontFamily('Geist').fontSize(14).fontColor(this.themeText).backgroundColor(Color.Transparent)
          .onClick(() => router.back())
        Text(uiText('会话', this.uiLocale))
          .fontFamily('Geist').fontSize(18)
          .fontWeight(FontWeight.Bold)
          .fontColor(this.themeText)
          .layoutWeight(1)
        Text(uiText(this.phase, this.uiLocale))
          .fontFamily('Geist').fontSize(11)
          .fontColor(this.themeWarning)
          .maxLines(1)
        if (this.phase.includes('重新配对')) {
          Button(uiText('重新配对', this.uiLocale)).height(28).fontFamily('Geist').fontSize(12).onClick(() => {
            router.replaceUrl({ url: 'pages/PairScan' }).catch(() => {});
          })
        }
        if (this.phase.startsWith('失败') || this.phase === '已断开') {
          Button(uiText('重试', this.uiLocale)).height(28).fontFamily('Geist').fontSize(11).onClick(() => {
            this.retryStartup();
          })
        }
        Button(this.showLog ? '页面' : '日志')
          .fontFamily('Geist').fontSize(11)
          .height(28)
          .onClick(() => {
            this.showLog = !this.showLog;
          })
      }
      .width('100%')
      .padding({ left: 12, right: 12, top: 8, bottom: 8 })
      }

      // Web must stay mounted regardless of the log overlay — conditional unmount
      // reloads the shell document and bounces the page back to the host root.
      Stack() {
        NodeContainer(this.documentMount).width('100%').height('100%').backgroundColor(this.themeBg)
        if (!this.hasDocument) {
          Column({ space: 12 }) {
            Text(uiText(this.phase, this.uiLocale))
              .fontFamily('Geist').fontSize(16)
              .fontColor(this.phase.startsWith('失败') ? this.themeWarning : this.themeText)
              .textAlign(TextAlign.Center)
            if (this.downloadPercent >= 0) {
              Progress({ value: this.downloadPercent, total: 100, type: ProgressType.Linear })
                .width('100%').color(this.themeText).backgroundColor(this.themeBorder)
              Text(`${this.downloadPercent}%`).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
            } else if (!this.phase.startsWith('失败') && !this.phase.includes('重新配对')
              && this.phase !== '主机不存在' && this.phase !== '已断开') {
              LoadingProgress().width(24).height(24).color(this.themeSecondary)
            }
          }
          .width('100%').constraintSize({ maxWidth: 420 })
          .padding({ left: 24, right: 24 })
        }

        if (this.showLog) {
          List({ space: 2 }) {
            ForEach(this.logs, (line: string) => {
              ListItem() {
                Text(line)
                  .fontFamily('Geist').fontSize(9)
                  .fontColor(this.themeSecondary)
                  .maxLines(3)
                  .width('100%')
              }
            }, (line: string, index: number) => `${index}-${line}`)
          }
          .width('100%')
          .height('100%')
          .padding({ left: 12, right: 12, top: 8 })
          .backgroundColor(this.themeBg)
        }
      }
      .width('100%')
      .layoutWeight(1)
    }
    .width('100%')
    .height('100%')
    .backgroundColor(this.themeBg)
  }
}
