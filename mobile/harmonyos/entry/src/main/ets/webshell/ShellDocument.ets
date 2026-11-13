import { BuilderNode, FrameNode, NodeController, UIContext } from '@kit.ArkUI';
import { webview } from '@kit.ArkWeb';
import { fileIo as fs } from '@kit.CoreFileKit';
import { BundleManifest, isSafeBundlePath, WebBundleFetcher } from '../transport/WebBundleFetcher';
import { BridgeHost } from './BridgeHost';
import { ShellDocumentFailure } from './ShellStartup';
import { SHELL_PAGE_CHANNEL_SCRIPT } from './ShellPageChannelScript';

const SHELL_ORIGIN = 'https://appassets.orca-shell.local';

const PARKED_FRAME = '{"v":1,"type":"parked"}';
let nextDocumentId = 0;

class ShellDocumentChannel {
  private bridge: BridgeHost | null = null;
  private earlyReady: string = '';
  private pushReady: boolean = false;
  private drawer: boolean = false;
  private disposed: boolean = false;
  private parked: () => void;

  constructor(parked: () => void) { this.parked = parked; }
  ready(): boolean { return this.earlyReady !== '' && this.pushReady; }

  isWorkspaceDrawer(): boolean { return this.drawer; }

  attach(bridge: BridgeHost, drawer: boolean): void {
    this.bridge = bridge; this.drawer = drawer;
    if (this.pushReady) { bridge.onPushChannelReady(); }
    if (this.earlyReady) {
      let frame = this.earlyReady; this.earlyReady = '';
      bridge.onClientMessage(frame);
    }
  }

  dispose(): void { this.disposed = true; this.bridge = null; this.earlyReady = ''; }

  postMessage(json: string): string {
    if (this.disposed) { return 'disposed'; }
    if (this.bridge) { this.bridge.onClientMessage(json); return 'ok'; }
    if (json.length > 65536) { return 'parked'; }
    try {
      let frame: ESObject = JSON.parse(json);
      if (frame?.['v'] === 1 && frame['type'] === 'ready') {
        this.earlyReady = json;
        if (this.pushReady) { this.parked(); }
      }
    } catch (e) {}
    return 'parked';
  }

  notifyOnMessageSet(): string {
    if (this.disposed) { return 'disposed'; }
    this.pushReady = true;
    if (this.bridge) { this.bridge.onPushChannelReady(); }
    else if (this.earlyReady) { this.parked(); }
    return 'ok';
  }
}

export class ShellDocument {
  readonly controller: webview.WebviewController = new webview.WebviewController();
  readonly channel: ShellDocumentChannel = new ShellDocumentChannel((): void => this.parkReady());
  readonly source: string;
  readonly baseDir: string;
  readonly manifest: BundleManifest;
  // The shared page lifts its input dock while preserving the desktop terminal size.
  readonly keyboardMode: WebKeyboardAvoidMode = AppStorage.get<boolean>('shellKeyboardOverlay')
    ? WebKeyboardAvoidMode.OVERLAYS_CONTENT : WebKeyboardAvoidMode.RESIZE_CONTENT;
  readonly scripts: ScriptItem[] = [{ script: SHELL_PAGE_CHANNEL_SCRIPT, scriptRules: [SHELL_ORIGIN] }];
  private node: BuilderNode<ShellDocument[]> | null = null;
  private bridge: BridgeHost | null = null;
  private parked: boolean;
  private announcedReady: boolean = false;
  private disposed: boolean = false;
  onReady: () => void = (): void => {};
  onLoaded: () => void = (): void => {};
  onFailure: (reason: ShellDocumentFailure) => void = (_reason: ShellDocumentFailure): void => {};
  allowExternal: () => boolean = (): boolean => false;

  constructor(manifest: BundleManifest, baseDir: string, parked: boolean) {
    this.manifest = manifest; this.baseDir = baseDir; this.parked = parked;
    this.source = `${SHELL_ORIGIN}/${manifest.entrypoint}?document=${++nextDocumentId}`;
  }

  prepare(ui: UIContext): void {
    if (this.node || this.disposed) { return; }
    let node = new BuilderNode<ShellDocument[]>(ui);
    this.node = node;
    node.build(shellWebBuilder, this);
  }

  frame(): FrameNode | null { return this.node?.getFrameNode() ?? null; }
  isReady(): boolean { return !this.disposed && this.announcedReady && this.channel.ready(); }

  bind(bridge: BridgeHost, drawer: boolean): void {
    this.bridge = bridge; this.parked = false; this.channel.attach(bridge, drawer);
  }

  activate(): void {
    if (this.disposed) { return; }
    try { this.controller.onActive(); } catch (e) {}
  }

  private parkReady(): void {
    if (!this.parked || this.disposed) { return; }
    this.controller.runJavaScript(`window.__orcaNativePush(${JSON.stringify(PARKED_FRAME)})`).then((): void => {
      if (!this.parked || this.disposed || this.announcedReady) { return; }
      this.announcedReady = true;
      try { this.controller.onInactive(); } catch (e) {}
      this.onReady();
    }).catch(() => {});
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true; this.channel.dispose(); this.bridge = null;
    try { this.controller.stop(); } catch (e) {}
    this.node?.dispose(); this.node = null;
  }

  loadIntercept(request: WebResourceRequest): boolean {
    let target = request.getRequestUrl();
    if (target.startsWith(`${SHELL_ORIGIN}/`)) { return false; }
    if (!this.disposed && this.bridge && this.allowExternal()) {
      this.bridge.offerExternalNavigation(target, request.isMainFrame(), request.isRequestGesture(),
        request.isRedirect(), request.getRequestMethod());
    }
    return true;
  }

  intercept(target: string): WebResourceResponse | null {
    let prefix = `${SHELL_ORIGIN}/`;
    if (this.disposed || !target.startsWith(prefix)) { return null; }
    let relative = target.substring(prefix.length).split('?')[0].split('#')[0];
    try { relative = decodeURIComponent(relative); } catch (e) { return null; }
    if (!relative || relative.endsWith('/')) { relative += this.manifest.entrypoint; }
    if (!isSafeBundlePath(relative) || !this.manifest.assets.some((asset): boolean => asset.path === relative)) { return null; }
    let contentType = WebBundleFetcher.contentTypeFor(this.manifest, relative);
    let headers: Header[] = [
      { headerKey: 'Cache-Control', headerValue: 'no-cache' },
      { headerKey: 'Content-Type', headerValue: contentType }
    ];
    if (relative.endsWith('.html')) {
      headers.push({ headerKey: 'Content-Security-Policy',
        headerValue: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src blob:; font-src 'self' data:; connect-src 'none'" });
      headers.push({ headerKey: 'Referrer-Policy', headerValue: 'no-referrer' });
    }
    try {
      let response = new WebResourceResponse();
      response.setResponseHeader(headers);
      response.setResponseMimeType(contentType.split(';')[0].trim());
      response.setResponseEncoding('utf-8');
      response.setReasonMessage('OK'); response.setResponseCode(200);
      response.setResponseData(fs.openSync(`${this.baseDir}/${relative}`, fs.OpenMode.READ_ONLY).fd);
      response.setResponseIsReady(true);
      return response;
    } catch (e) { return null; }
  }
}

@Builder
function renderShellWeb(document: ShellDocument) {
  Web({ src: document.source, controller: document.controller })
    .backgroundColor(Color.Transparent)
    .keyboardAvoidMode(document.keyboardMode)
    .javaScriptProxy({ object: document.channel, name: 'orcaNative',
      methodList: ['postMessage', 'notifyOnMessageSet', 'isWorkspaceDrawer'], controller: document.controller })
    .javaScriptOnDocumentStart(document.scripts)
    .onControllerAttached((): void => document.activate())
    .onLoadIntercept((event): boolean => document.loadIntercept(event.data))
    .onPageEnd((event): void => { if (event.url === document.source) { document.onLoaded(); } })
    .onErrorReceive((event): void => {
      if (event.request.isMainFrame() && event.request.getRequestUrl() === document.source) {
        document.onFailure('page');
      }
    })
    .onRenderExited((): void => document.onFailure('renderer'))
    .onInterceptRequest((event) => { return document.intercept(event.request.getRequestUrl()); })
    .width('100%').height('100%')
}
const shellWebBuilder = wrapBuilder<ShellDocument[]>(renderShellWeb);

export class ShellDocumentMount extends NodeController {
  private document: ShellDocument | null = null;
  makeNode(_ui: UIContext): FrameNode | null { return this.document?.frame() ?? null; }
  setDocument(document: ShellDocument | null): void {
    this.document = document; this.rebuild();
  }
}
