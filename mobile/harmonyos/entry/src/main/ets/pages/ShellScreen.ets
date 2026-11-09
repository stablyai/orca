import { uiText } from '../settings/NativeUi';
import { HostSession, SessionPhase } from '../transport/HostSession';
import { readHomeResume, saveHomeResume, resumeFromLocation } from '../home/HomeResume';
import { NativeDevice } from '../webshell/NativeDevice';
import { PageStorageStore } from '../storage/PageStorageStore';
import { appendLog as recordConnection, LOG_LEVEL_INFO, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { router } from '@kit.ArkUI';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { WebBundleFetcher, BundleManifest, isSafeBundlePath } from '../transport/WebBundleFetcher';
import { ShellStartup } from '../webshell/ShellStartup';
import { BridgeHost, BridgeNativePage } from '../webshell/BridgeHost';
import fflateModule from '../vendor/fflate-umd.js';
import { listHosts, getDeviceToken, getRelayCredential, HostMeta } from '../storage/HostStore';
import { AgentWatch } from '../notifications/AgentWatch';
import { LocalNotifier, DesktopNotification } from '../notifications/LocalNotifier';
import { getBool, KEY_NOTIFICATIONS_LOCAL_ENABLED } from '../settings/SettingsStore';

/**
 * Shell screen (Phase 2a): downloads the desktop web bundle into the sandbox and
 * renders it inside an ArkWeb fence — local origin via onInterceptRequest, CSP on
 * the document, and the orcaBridge page channel through a document-start shim that
 * wraps the injected orcaNative proxy.
 */

const SHELL_ORIGIN = 'https://appassets.orca-shell.local';

// Page channel shim: window.orcaBridge (postMessage + assignable onmessage) over the
// orcaNative proxy, mirroring orca-bridge-page-channel.ts's exact surface.
const BRIDGE_SHIM = `
(function () {
  'use strict';
  var native = window.orcaNative;
  if (!native || typeof native.postMessage !== 'function') {
    window.__orcaShellError = 'orcaNative proxy missing';
    return;
  }
  var queued = [];
  var handler = null;
  var bridge = {
    postMessage: function (json) { native.postMessage(String(json)); },
  };
  Object.defineProperty(bridge, 'onmessage', {
    set: function (fn) {
      handler = fn;
      try { native.notifyOnMessageSet(); } catch (e) { /* proxy not callable yet */ }
      while (queued.length > 0) {
        var f = queued.shift();
        try { fn({ data: f }); } catch (e) { /* handler error surfaces via page console */ }
      }
    },
    get: function () { return handler; },
    configurable: true
  });
  window.orcaBridge = bridge;
  ['warn', 'error'].forEach(function (level) {
    var orig = console[level].bind(console);
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        try {
          var a = arguments[i];
          parts.push(typeof a === 'string' ? a : JSON.stringify(a));
        } catch (e) { parts.push('[unserializable]'); }
      }
      try {
        native.postMessage(JSON.stringify({ v: 1, type: 'page.console', level: level, text: parts.join(' ').slice(0, 400) }));
      } catch (e2) { /* drop */ }
      orig.apply(null, arguments);
    };
  });
  window.__orcaNativePush = function (json) {
    if (handler) {
      try { handler({ data: json }); return 'delivered'; }
      catch (e) { return 'error: ' + (e && e.message || String(e)); }
    }
    queued.push(json);
    return 'queued';
  };
})();
`;

class OrcaNativeProxy {
  private bridge: BridgeHost | null = null;
  private logSink: ((line: string) => void) | null = null;

  setBridge(bridge: BridgeHost | null): void {
    this.bridge = bridge;
  }

  setLogSink(sink: (line: string) => void): void {
    this.logSink = sink;
  }

  postMessage(json: string): string {
    if (this.bridge) {
      this.bridge.onClientMessage(json);
      return 'ok';
    }
    return 'no-bridge';
  }

  notifyOnMessageSet(): string {
    if (this.bridge) {
      this.bridge.onPushChannelReady();
    }
    return 'ok';
  }
}

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
  controller: webview.WebviewController = new webview.WebviewController();
  private nativeProxy: OrcaNativeProxy = new OrcaNativeProxy();
  private bridge: BridgeHost | null = null;
  private client: SpikeRpcClient | null = null;
  private hostId: string = '';
  private hostMeta: HostMeta | null = null;
  @State phase: string = '启动中…';
  @State downloadPercent: number = -1;
  @State logs: string[] = [];
  @State webSrc: string = '';
  @State showLog: boolean = false;
  private startup: ShellStartup = new ShellStartup((message: string): void => this.failStartup(message));
  private startupGeneration: number = 0;
  private painted: boolean = false;
  private manifest: BundleManifest | null = null;
  private agentWatch: AgentWatch | null = null;
  private notifier: LocalNotifier = new LocalNotifier();
  private baseDir: string = '';
  private routePathname: string = '';
  private routeParams: Record<string, string> = {};
  private supervisor: HostSession | null = null;
  private nativeDevice: NativeDevice | null = null;
  private disposed: boolean = false;
  private pageVisible: boolean = true;
  private foreground: boolean = true;
  private foregroundListener: () => void = (): void => {
    this.foreground = true; this.updateViewing();
  };
  private hostEndpointListener: (hostId: string, endpoint: string) => void = (hostId: string, endpoint: string): void => {
    if (this.disposed || hostId !== this.hostId || this.hostMeta?.endpoint === endpoint) { return; }
    this.suspendTransport(0);
    let previous = this.supervisor;
    this.supervisor = null;
    if (previous) { previous.stop(); }
    this.boot();
  };
  private generation: number = 0;
  private backgroundListener: () => void = (): void => {
    this.foreground = false; this.notifier.setViewing('', '');
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
    this.nativeProxy.setLogSink((line: string): void => this.appendLog(line));
    (getContext(this) as common.UIAbilityContext).eventHub.on('orcaBackground', this.backgroundListener);
    (getContext(this) as common.UIAbilityContext).eventHub.on('orcaForeground', this.foregroundListener);
    (getContext(this) as common.UIAbilityContext).eventHub.on('orcaHostEndpointSaved', this.hostEndpointListener);
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
    (getContext(this) as common.UIAbilityContext).eventHub.off('orcaHostEndpointSaved', this.hostEndpointListener);
    if (this.supervisor) { this.supervisor.stop(); this.supervisor = null; }
    this.releaseBridge();
  }
  onBackPress(): boolean {
    if (this.showLog) { this.showLog = false; return true; }
    return this.bridge ? this.bridge.handleBack() : false;
  }
  onPageShow(): void {
    this.pageVisible = true; this.updateViewing();
    if (this.client && this.hostMeta && !this.agentWatch) { this.startAgentWatch(this.client, this.hostMeta); }
  }
  onPageHide(): void {
    this.pageVisible = false; this.notifier.setViewing('', '');
    if (this.agentWatch) { this.agentWatch.stop(); this.agentWatch = null; }
    if (this.nativeDevice) { this.nativeDevice.pause().catch(() => {}); }
  }
  private updateViewing(): void {
    if (!this.pageVisible || !this.foreground || !this.bridge) { this.notifier.setViewing('', ''); return; }
    let route = resumeFromLocation(this.hostId, this.bridge.getRoute(), this.bridge.getRouteParams());
    if (route) { this.notifier.setViewing(route.hostId, route.worktreeId, route.executionHost); }
    else { this.notifier.setViewing('', ''); }
  }
  private recordResume(pathname: string, params: Record<string, string>): void {
    try {
      let next = resumeFromLocation(this.hostId, pathname, params);
      if (next && this.pageVisible && this.foreground) { this.notifier.setViewing(next.hostId, next.worktreeId, next.executionHost); }
      else { this.notifier.setViewing('', ''); }
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
    this.nativeProxy.setBridge(null);
    this.stopAgentWatch();
    if (this.nativeDevice) { this.nativeDevice.dispose().catch(() => {}); this.nativeDevice = null; }
    this.client = null;
  }
  private stopAgentWatch(): void {
    if (this.agentWatch) { this.agentWatch.stop(); this.agentWatch = null; }
  }
  private suspendTransport(attempt: number): void {
    this.startup.cancel(); this.generation++;
    if (!this.painted || !this.bridge) { this.releaseBridge(); return; }
    this.client = null;
    this.stopAgentWatch();
    this.nativeDevice?.setDesktopClient(null);
    this.bridge.suspendTransport(attempt);
  }
  private failStartup(message: string): void {
    if (this.disposed) { return; }
    this.startup.cancel(); this.generation++; this.releaseBridge();
    this.webSrc = ''; this.painted = false;
    if (this.supervisor) { this.supervisor.stop(); }
    this.publishPhase(`失败：${message}`);
  }

  private pagePainted(client: SpikeRpcClient, generation: number): void {
    if (this.disposed || generation !== this.generation || this.client !== client) { return; }
    if (this.startup.complete(this.startupGeneration)) {
      this.painted = true; this.publishPhase('已连接');
    }
  }

  private publishPhase(state: string): void {
    if (this.disposed || this.phase === state) { return; }
    this.phase = state;
    recordConnection(getContext(this), state.startsWith('失败') ? LOG_LEVEL_ERROR : LOG_LEVEL_INFO, state, '').catch(() => {});
  }

  /** Phase 4a: watch agent states on the open channel and raise local notifications. */
  private startAgentWatch(client: SpikeRpcClient, meta: HostMeta): void {
    getBool(getContext(this), KEY_NOTIFICATIONS_LOCAL_ENABLED).then((enabled: boolean): void => {
      if (!enabled || this.disposed || !this.pageVisible || this.client !== client || this.agentWatch) {
        this.appendLog('本地通知已关闭（设置 → 通知）');
        return;
      }
      let notifier = this.notifier;
      notifier.setLogSink((line: string): void => this.appendLog(`[notify] ${line}`));
      let context = getContext(this) as common.UIAbilityContext;
      notifier.setContext(context);
        notifier.ensureSlot().then((_ok: boolean): void => {
          if (this.disposed || !this.pageVisible || this.client !== client || this.agentWatch) { return; }
          let watch = new AgentWatch({
            deviceToken: client.deviceToken,
            hostId: meta.id,
            subscribe: (id: string, wire: string, onEvent: (responseJson: string) => void): boolean =>
              client.subscribeWithId(id, wire, onEvent),
            cancel: (id: string): void => client.cancelById(id),
            notify: (title: string, body: string, hostId: string, worktreeId: string, paneKey?: string, executionHost?: string): boolean =>
              notifier.publishAgentEvent(title, body, hostId, worktreeId, paneKey, executionHost),
            notifyEvent: (event: DesktopNotification): boolean => notifier.publishDesktopEvent(event),
            dismiss: (id: string): void => { notifier.dismiss(id).catch(() => {}); },
            logSink: (line: string): void => this.appendLog(`[watch] ${line}`)
          });
          this.agentWatch = watch;
          if (watch.start()) {
            this.appendLog('agent 状态监视已启动');
          }
        }).catch((_e: Error) => {
        });
    }).catch((_e: Error) => {
    });
  }

  async boot(): Promise<void> {
    let generation = ++this.generation;
    try {
      let hosts: HostMeta[] = await listHosts(getContext(this));
      if (this.disposed || generation !== this.generation) { return; }
      let meta: HostMeta | null = null;
      for (let i = 0; i < hosts.length; i++) {
        if (hosts[i].id === this.hostId) {
          meta = hosts[i];
          break;
        }
      }
      if (meta === null) {
        this.publishPhase('主机不存在');
        return;
      }
      let token = await getDeviceToken(getContext(this), meta.id);
      if (this.disposed || generation !== this.generation) { return; }
      if (token === null) {
        this.publishPhase('凭证缺失 — 请重新配对');
        return;
      }

      let context = getContext(this) as common.UIAbilityContext;
      let relayCredential = await getRelayCredential(context, meta.id);
      if (this.disposed || generation !== this.generation) { return; }
      this.hostMeta = meta;
      let supervisor = new HostSession(meta, token, relayCredential ?? undefined, context); this.supervisor = supervisor;
      supervisor.setClientSetup((client: SpikeRpcClient): void => client.setFflate(fflateModule));
      supervisor.setLogSink((line: string): void => this.appendLog(line));
      let host = meta;
      supervisor.addListener((phase: SessionPhase, detail: string): void => {
        if (this.disposed || this.supervisor !== supervisor) { return; }
        if (phase === 'connected') {
          let client = supervisor.getClient();
          if (client) { this.loadConnected(client, host).catch(() => {}); }
        } else if (phase === 'reconnecting') {
          this.suspendTransport(supervisor.getReconnectAttempt()); this.publishPhase(`连接中断 · ${detail}`);
        } else if (phase === 'connecting') { this.publishPhase('连接桌面…'); }
        else if (phase === 'auth-failed') {
          this.startup.cancel(); this.generation++; this.releaseBridge(); this.publishPhase('凭证已失效，请重新配对');
          this.webSrc = ''; this.painted = false;
        }
      });
      supervisor.start();
    } catch (e) {
      if (!this.disposed && generation === this.generation) { this.publishPhase('失败：无法读取桌面凭证，请重新配对'); }
    }
  }

  private async loadConnected(client: SpikeRpcClient, meta: HostMeta): Promise<void> {
    let path = this.supervisor?.getActivePath() ?? 'lan';
    if (this.painted && this.bridge && this.nativeDevice) {
      this.stopAgentWatch();
      this.client = client; this.hostMeta = meta;
      this.nativeDevice.setDesktopClient(client);
      this.bridge.attachTransport(client, path);
      this.publishPhase('已连接');
      this.startAgentWatch(client, meta);
      return;
    }
    let generation = ++this.generation; this.releaseBridge(); this.client = client;
    this.hostMeta = meta;
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
      this.manifest = manifest; this.baseDir = baseDir;
      let storage = new PageStorageStore(getContext(this), meta.id);
      let nativeDevice = new NativeDevice(getContext(this) as common.UIAbilityContext, client); this.nativeDevice = nativeDevice;
      let bridge = new BridgeHost(client, this.controller, manifest, meta, this.routePathname, path);
      bridge.setStorage(storage); bridge.setColorScheme(this.scheme); bridge.setUiLocale(this.uiLocale); bridge.setRouteParams(this.routeParams);
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
      this.bridge = bridge; this.nativeProxy.setBridge(bridge);
      let wasMounted = this.webSrc.length > 0;
      this.webSrc = `${SHELL_ORIGIN}/${manifest.entrypoint}?generation=${generation}`;
      this.publishPhase('正在打开会话…');
      if (wasMounted) { this.controller.loadUrl(this.webSrc); }
      this.startAgentWatch(client, meta);
    } catch (e) {
      if (!this.disposed && generation === this.generation) { this.failStartup('会话加载未完成，请重试'); }
    }
  }

  build() {
    Column() {
      if (this.webSrc.length === 0 || this.phase !== '已连接' || this.showLog) {
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
        if (this.phase.startsWith('失败')) {
          Button(uiText('重试', this.uiLocale)).height(28).fontFamily('Geist').fontSize(11).onClick(() => {
            if (this.supervisor) { this.supervisor.stop(); this.supervisor.start(); }
            else { this.boot(); }
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
        if (this.webSrc !== '' && this.manifest !== null) {
          Web({ src: this.webSrc, controller: this.controller })
            .keyboardAvoidMode(WebKeyboardAvoidMode.RESIZE_CONTENT)
            .javaScriptProxy({
              object: this.nativeProxy,
              name: 'orcaNative',
              methodList: ['postMessage', 'notifyOnMessageSet'],
              controller: this.controller
            })
            .javaScriptOnDocumentStart(((): Array<ScriptItem> => {
              let item: ScriptItem = { script: BRIDGE_SHIM, scriptRules: [SHELL_ORIGIN] };
              let items: Array<ScriptItem> = [item];
              return items;
            })())
            .onLoadIntercept((event) => {
              let target = event.data.getRequestUrl();
              if (target.startsWith(`${SHELL_ORIGIN}/`)) { return false; }
              if (this.pageVisible && this.foreground && this.bridge) {
                this.bridge.offerExternalNavigation(target, event.data.isMainFrame(), event.data.isRequestGesture(),
                  event.data.isRedirect(), event.data.getRequestMethod());
              }
              return true;
            })
            .onPageEnd((event) => {
              if (event.url === this.webSrc && !this.painted && this.bridge) { this.publishPhase('页面已加载，正在初始化…'); }
            })
            .onErrorReceive((event) => {
              if (event.request.isMainFrame() && event.request.getRequestUrl() === this.webSrc) {
                this.failStartup('会话页面加载失败，请重试');
              }
            })
            .onRenderExited(() => this.failStartup('会话页面进程已退出，请重试'))
            .onInterceptRequest((event) => {
              let url = event.request.getRequestUrl();
              let marker = `${SHELL_ORIGIN}/`;
              if (!url.startsWith(marker)) {
                return null;
              }
              let relPath = url.substring(marker.length).split('?')[0].split('#')[0];
              try { relPath = decodeURIComponent(relPath); } catch (e) { return null; }
              if (relPath.length === 0 || relPath.endsWith('/')) {
                relPath += this.manifest!.entrypoint;
              }
              if (!isSafeBundlePath(relPath) || !this.manifest!.assets.some((asset): boolean => asset.path === relPath)) { return null; }
              let file = `${this.baseDir}/${relPath}`;
              let contentType = '';
              try {
                contentType = WebBundleFetcher.contentTypeFor(this.manifest!, relPath);
              } catch (e) {
                contentType = 'application/octet-stream';
              }
              let headers: Record<string, string> = {
                'Cache-Control': 'no-cache',
                'Content-Type': contentType
              };
              if (relPath.endsWith('.html')) {
                // Fenced document: script only from the bundle origin (upstream shell CSP policy).
                headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src blob:; font-src 'self' data:; connect-src 'none'";
                headers['Referrer-Policy'] = 'no-referrer';
              }
              try {
                let fd = fs.openSync(file, fs.OpenMode.READ_ONLY).fd;
                let response = new WebResourceResponse();
                let headerList: Header[] = [];
                let headerKeys = Object.keys(headers);
                for (let h = 0; h < headerKeys.length; h++) {
                  let entry: Header = { headerKey: headerKeys[h], headerValue: headers[headerKeys[h]] };
                  headerList.push(entry);
                }
                response.setResponseHeader(headerList);
                // mimeType must be the bare media type; parameters belong in the header.
                let mimeType = contentType.split(';')[0].trim();
                response.setResponseMimeType(mimeType);
                response.setResponseEncoding('utf-8');
                response.setReasonMessage('OK');
                response.setResponseCode(200);
                response.setResponseData(fd);
                response.setResponseIsReady(true);
                return response;
              } catch (e) {
                return null;
              }
            })
            .width('100%')
            .height('100%')
            .backgroundColor(this.themeBg)
        } else {
          Column({ space: 12 }) {
            Text(uiText(this.phase, this.uiLocale))
              .fontFamily('Geist').fontSize(16)
              .fontColor(this.phase.startsWith('失败') ? this.themeWarning : this.themeText)
              .textAlign(TextAlign.Center)
            if (this.downloadPercent >= 0) {
              Progress({ value: this.downloadPercent, total: 100, type: ProgressType.Linear })
                .width('100%').color(this.themeText).backgroundColor(this.themeBorder)
              Text(`${this.downloadPercent}%`).fontFamily('Geist').fontSize(13).fontColor(this.themeSecondary)
            } else if (!this.phase.startsWith('失败') && !this.phase.includes('重新配对') && this.phase !== '主机不存在') {
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
