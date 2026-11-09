import { utf8Encode, utf8Decode, base64Encode } from '../transport/crypto/Bytes';
import { PageStorageStore } from '../storage/PageStorageStore';
import { webview } from '@kit.ArkWeb';
import { url } from '@kit.ArkTS';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from '../transport/SpikeRpcClient';
import { BundleManifest, BundleRoute } from '../transport/WebBundleFetcher';
import {
  decodeTerminalFrame,
  convertTerminalFrame,
  encodeTerminalFrame,
  encodeViewportJson,
  TerminalSnapshotState,
  isTerminalFrame,
  OP_CLAIM_VIEWPORT,
  OP_RESIZE,
  OP_OUTPUT,
  OP_OUTPUT_SPAN
} from '../transport/TerminalBinaryFrame';
import { HostMeta } from '../storage/HostStore';

/**
 * Bridge host (Phase 2b): the page↔shell JSON protocol from
 * mobile/src/mobile-web-shell/bridge (envelope v1). Handles ready→init handshake,
 * request/subscribe forwarding (bridge ids round-trip on the wire), event/reply/end
 * frames, page-notify handling (storage writes, terminal viewport → binary
 * Resize/ClaimViewport control frames, navigate-back), and native.storage.read.
 *
 * Page channel semantics (orca-bridge-page-channel.ts): the page calls
 * window.orcaBridge.postMessage(json) and assigns window.orcaBridge.onmessage.
 * ArkWeb proxies cannot carry a JS-set callback property, so a document-start shim
 * (ShellScreen) wraps the injected `orcaNative` proxy into that exact surface and
 * exposes window.__orcaNativePush for native→page frames.
 */

const BRIDGE_PROTOCOL_VERSION = 1;
const MAX_PENDING_REQUESTS = 64;
const MAX_SUBSCRIPTIONS = 32;
// src/shared/mobile-bridge-frame-bytes.ts
const BRIDGE_MAX_FRAME_BYTES = 640 * 1024;

// Page storage grant (page-storage-keys.ts): exact allowlist, prefixes and bounds.
const PAGE_STORAGE_EXACT_KEYS: string[] = [
  'orca:last-visited-worktree',
  'orca:hostSidebarWidth',
  'orca:hostDockWidth',
  'orca:terminal-accessory-layout',
  'orca:custom-accessory-keys',
  'orca:defaultSessionView',
  'orca:mobileStructuredSendOperations:v1',
  'orca:terminalTextScale',
  'orca:terminalAutocompleteEnabled',
  'orca:terminalLinkOpenMode',
  'orca:terminalSplitLayout'
];
const PAGE_STORAGE_KEY_PREFIXES: string[] = [
  'orca:pins:',
  'orca:nativeChatTabs:',
  'orca:terminalLiveInputDisabled:',
  'orca:terminalDrafts:'
];
const NEGOTIATED_PAGE_STORAGE_KEY = 'orca:terminalSplitLayout';
const PAGE_STORAGE_MAX_VALUE_CHARS = 16 * 1024;
const PAGE_STORAGE_MAX_KEY_CHARS = 256;
const PAGE_STORAGE_MAX_ENTRIES = 32;
// bridge-caps.ts viewport bounds (terminalViewport notify envelope).
const BRIDGE_MAX_VIEWPORT_COLS = 1000;
const BRIDGE_MAX_VIEWPORT_ROWS = 500;

interface BridgeConnectionSnapshot {
  state: string;
  reconnectAttempt: number;
  lastConnectedAt: number;
  lastInboundAt: number;
  generation: number;
  activePath: string;
}

interface BridgeRpcGrants {
  maxPendingRequests: number;
  maxSubscriptions: number;
}

interface BridgeGrantsWire {
  rpc: BridgeRpcGrants;
  native: string[];
}

interface BridgeRouteWire {
  pathname: string;
  params: Record<string, string>;
}

export type BridgeNativePage = 'edit-host' | 'connection-log';

interface BridgeInitHostWire {
  personalName?: string;
  lastKnownMachineName?: string;
  id: string;
  name: string;
  endpoint: string;
  lastConnected: number;
}

export interface BridgeSafeAreaInsets { top: number; right: number; bottom: number; left: number; }
export interface BridgePageOcclusion { x: number; y: number; width: number; height: number; }
export interface BridgePageGeometry { occlusions: BridgePageOcclusion[]; sideRail: boolean; directionPadAvailable?: boolean; }

interface BridgeInitWire {
  v: number;
  type: string;
  sessionId: string;
  buildId: string;
  connection: BridgeConnectionSnapshot;
  grants: BridgeGrantsWire;
  route: BridgeRouteWire;
  pageRoutes: string[];
  colorScheme: string;
  uiLocale: string;
  host: BridgeInitHostWire;
  storage: Record<string, string>;
  storageOversize: string[];
  ownsHostArea: boolean;
  safeAreaInsets: BridgeSafeAreaInsets;
  keyboardInset: number;
  pageGeometry: BridgePageGeometry;
  foldDivision: Object | null;
}

/** A forwarded terminal.subscribe: the handle its params named, for viewport routing. */
interface StreamWindowFrame { seq: number; bytes: number; json: string; }
interface StreamWindow { outstanding: StreamWindowFrame[]; bytes: number; backlog: StreamWindowFrame[]; backlogBytes: number; }
interface DesktopSubscriptionRecord { method: string; params: ESObject; envelope: ESObject; readyId: string; cancelled: boolean; }
interface TerminalSubscriptionRecord {
  bridgeId: string;
  terminal: string;
}

export class BridgeHost {
  private client: SpikeRpcClient;
  private controller: webview.WebviewController;
  private manifest: BundleManifest;
  private meta: HostMeta;
  private sessionId: string;
  private routePathname: string;
  private routeParams: Record<string, string> = {};
  private binarySubscriptions: Set<string> = new Set();
  private seq: Map<string, number> = new Map();
  private streamIds: Map<number, string> = new Map();
  private snapshots: Map<number, TerminalSnapshotState> = new Map();
  private streamWindows: Map<string, StreamWindow> = new Map();
  private desktopSubs: Map<string, DesktopSubscriptionRecord> = new Map();
  private subscriptions: Set<string> = new Set();
  /** bridge id → terminal handle for live terminal.subscribe calls. */
  private terminalSubs: Map<string, TerminalSubscriptionRecord> = new Map();
  /** Page storage grant: allowlisted keys only, kept for the next init. */
  private pageStorage: Map<string, string> = new Map();
  /** Keys the page declared in `ready` storageKeys (negotiated-key gate). */
  private declaredStorageKeys: string[] = [];
  /** Keys whose stored value exceeded the page cap; writes to them are refused. */
  private oversizeKeys: Set<string> = new Set();
  private unsubscribeCounter = 0;
  private pushQueue: string[] = [];
  private pushReady = false;
  private disposed = false;
  private storageStore: PageStorageStore | null = null;
  private pendingIds: Set<string> = new Set();
  private backClaimed: boolean = false;
  private nativeHandler: ((method: string, params: ESObject) => Promise<Object>) | null = null;
  private nativeMethods: string[] = [];
  private onBack: ((home: boolean) => void) | null = null;
  private onPaint: (() => void) | null = null;
  private safeAreaInsets: BridgeSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private keyboardInset: number = 0;
  private pageGeometry: BridgePageGeometry = { occlusions: [], sideRail: false, directionPadAvailable: false };
  private readySink: (() => void) | null = null;
  private faultSink: ((message: string) => void) | null = null;
  private pageFaulted: boolean = false;
  private probing: boolean = false;
  private lastProbeAt: number = 0;
  setReadySink(sink: () => void): void { this.readySink = sink; }
  setFaultSink(sink: (message: string) => void): void { this.faultSink = sink; }
  private validInset(value: number): boolean { return Number.isFinite(value) && value >= 0 && value <= 4096; }
  setSafeAreaInsets(value: BridgeSafeAreaInsets): void {
    if (![value.top, value.right, value.bottom, value.left].every((inset: number): boolean => this.validInset(inset))
      || JSON.stringify(value) === JSON.stringify(this.safeAreaInsets)) { return; }
    this.safeAreaInsets = value; if (this.pushReady && !this.disposed) { this.sendInit(); }
  }
  setKeyboardInset(value: number): void {
    if (!this.validInset(value) || value === this.keyboardInset) { return; }
    this.keyboardInset = value; if (this.pushReady && !this.disposed) { this.sendInit(); }
  }
  setPageGeometry(value: BridgePageGeometry): void {
    if (!Array.isArray(value.occlusions) || value.occlusions.length > 16 || typeof value.sideRail !== 'boolean'
      || (value.directionPadAvailable !== undefined && typeof value.directionPadAvailable !== 'boolean')
      || value.occlusions.some((rect: BridgePageOcclusion): boolean => ![rect.x, rect.y, rect.width, rect.height].every((coordinate: number): boolean => this.validInset(coordinate)))
      || JSON.stringify(value) === JSON.stringify(this.pageGeometry)) { return; }
    this.pageGeometry = value; if (this.pushReady && !this.disposed) { this.sendInit(); }
  }
  private locale: string = 'en';
  private externalLink: ((url: string) => Promise<void>) | null = null;
  private externalNavigationEnabled: boolean = false;
  private haptics: ((kind: string) => Promise<void>) | null = null;
  setUiLocale(locale: string): void {
    if (!['en', 'zh', 'zh-Hant', 'ko', 'ja', 'es', 'fr', 'pt', 'ru', 'tr', 'de'].includes(locale) || this.locale === locale) { return; }
    this.locale = locale; if (this.pushReady && !this.disposed) { this.sendInit(); }
  }
  setDeviceNotifies(externalLink: (url: string) => Promise<void>, haptics: (kind: string) => Promise<void>,
    externalNavigation: boolean = false): void {
    this.externalLink = externalLink; this.haptics = haptics; this.externalNavigationEnabled = externalNavigation;
  }
  offerExternalNavigation(target: string, mainFrame: boolean, userGesture: boolean, redirect: boolean, method: string): void {
    if (this.disposed || !this.pushReady || !this.externalLink || !mainFrame || !userGesture || redirect || method !== 'GET'
      || target.length > 2048 || !this.routeGrants().includes('externalNavigation')) { return; }
    try {
      let parsed = url.URL.parseURL(target);
      if (!['https:', 'http:', 'mailto:'].includes(parsed.protocol) || parsed.href.length > 2048) { return; }
      this.externalLink(parsed.href).catch((): void => this.log('Unable to open external link'));
    } catch (e) {}
  }
  private connectionPath: string = 'lan';
  setConnectionPath(path: string): void { this.connectionPath = path; }
  private scheme: string = 'dark';
  private locationSink: ((pathname: string, params: Record<string, string>) => void) | null = null;
  private nativeNavigation: ((page: BridgeNativePage, replace: boolean) => void) | null = null;
  setLocationSink(sink: (pathname: string, params: Record<string, string>) => void): void { this.locationSink = sink; }
  setNativeNavigation(sink: (page: BridgeNativePage, replace: boolean) => void): void { this.nativeNavigation = sink; }

  setStorage(store: PageStorageStore): void { this.storageStore = store; this.pageStorage = store.entries(); }
  setRouteParams(params: Record<string, string>): void { this.routeParams = params; }
  setColorScheme(scheme: string): void {
    if (this.scheme === scheme) { return; }
    this.scheme = scheme; if (this.pushReady && !this.disposed) { this.sendInit(); }
  }
  setNativeHandler(methods: string[], handler: (method: string, params: ESObject) => Promise<Object>): void {
    this.nativeMethods = methods; this.nativeHandler = handler;
  }
  setNavigation(back: (home: boolean) => void, paint: () => void): void { this.onBack = back; this.onPaint = paint; }
  getRoute(): string { return this.routePathname; }
  getRouteParams(): Record<string, string> { return this.routeParams; }
  handleBack(): boolean {
    if (!this.backClaimed || this.disposed) { return false; }
    this.pushFrame('{"v":1,"type":"back"}'); return true;
  }
  dispose(): void {
    if (this.disposed) { return; }
    let ids = Array.from(this.subscriptions);
    for (let i = 0; i < ids.length; i++) { this.releaseDesktopSubscription(ids[i]); }
    this.notifyStreamsEnded(); this.disposed = true;
    this.pushQueue = []; this.pendingIds.clear();
  }
  private logSink: ((line: string) => void) | null = null;

  constructor(client: SpikeRpcClient, controller: webview.WebviewController,
    manifest: BundleManifest, meta: HostMeta, routePathname: string) {
    this.client = client;
    this.controller = controller;
    this.manifest = manifest;
    this.meta = meta;
    this.routePathname = routePathname;
    this.sessionId = `sess-${meta.id}-${Date.now()}`;
    client.onBinaryFrames((bytes: Uint8Array): void => {
      if (bytes[0] === 0x62) { this.onScreencastBinary(bytes); }
      else { this.onTerminalBinary(bytes); }
    });
  }

  /** Desktop→mobile terminal frames (0x74) → JSON result → bridge event for the subscribing page. */
  private onTerminalBinary(bytes: Uint8Array): void {
    if (!isTerminalFrame(bytes)) {
      return; // screencast/other lanes arrive later (Phase 2b+)
    }
    let frame = decodeTerminalFrame(bytes);
    if (frame === null) {
      return;
    }
    let bridgeId = this.streamIds.get(frame.streamId);
    if (bridgeId === undefined) {
      if (frame.opcode !== OP_OUTPUT && frame.opcode !== OP_OUTPUT_SPAN) {
        this.log(`terminal frame for unknown stream ${frame.streamId} (opcode ${frame.opcode})`);
      }
      return;
    }
    let resultJson = convertTerminalFrame(frame, this.snapshots);
    if (resultJson === null) {
      return;
    }
    let seq = this.nextSeq(bridgeId);
    let frameJson = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"event","id":${JSON.stringify(bridgeId)},"seq":${seq},"payload":${resultJson}}`;
    this.pushStreamFrame(bridgeId, seq, frameJson, false);
  }

  setLogSink(sink: (line: string) => void): void {
    this.logSink = sink;
  }

  private log(line: string): void {
    if (this.logSink) {
      this.logSink(line);
    }
  }

  /** Upstream matchesRoutePattern: [dyn] segments match any non-empty path segment. */
  private routeMatches(pattern: string, pathname: string): boolean {
    let pat = pattern.split('/');
    let act = pathname.split('/');
    if (pat.length !== act.length) {
      return false;
    }
    for (let i = 0; i < pat.length; i++) {
      let seg = pat[i];
      if (seg.length > 2 && seg.charAt(0) === '[' && seg.charAt(seg.length - 1) === ']') {
        if (act[i].length === 0) {
          return false;
        }
      } else if (seg !== act[i]) {
        return false;
      }
    }
    return true;
  }

  private ownsHostArea(): boolean {
    for (let i = 0; i < this.manifest.routes.length; i++) {
      let route: BundleRoute = this.manifest.routes[i];
      if (route.canOwnHostArea && this.routeMatches(route.pathname, this.routePathname)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Route grants (page-route-policy.ts routeViewOf): the active route's declared +
   * optional grants; a host-area owner gets the union of every served route plus
   * native.storage.read. Session pages navigate in-document, so the union is what
   * keeps their storage/navigate/verb grants alive on a single Web instance.
   */
  private supportsGrant(grant: string): boolean {
    if (grant.startsWith('native.')) {
      return this.nativeMethods.includes(grant) || ['native.storage.read', 'native.store.rows'].includes(grant);
    }
    if (grant === 'fault') { return this.faultSink !== null; }
    if (grant === 'externalLink') { return this.externalLink !== null; }
    if (grant === 'externalNavigation') { return this.externalNavigationEnabled; }
    if (grant === 'haptics') { return this.haptics !== null; }
    return ['navigate', 'storage', 'rpcEnvelope', 'screencastBinary'].includes(grant);
  }

  private routeGrants(): string[] {
    let grants: string[] = ['rpcEnvelope'];
    let seen: Set<string> = new Set();
    let hostArea = this.ownsHostArea();
    for (let i = 0; i < this.manifest.routes.length; i++) {
      let route: BundleRoute = this.manifest.routes[i];
      let include = hostArea ? true : this.routeMatches(route.pathname, this.routePathname);
      if (!include) {
        continue;
      }
      for (let j = 0; j < route.grants.length; j++) {
        if (!seen.has(route.grants[j])) {
          seen.add(route.grants[j]);
          if (this.supportsGrant(route.grants[j])) { grants.push(route.grants[j]); }
        }
      }
      for (let j = 0; j < route.optionalGrants.length; j++) {
        if (!seen.has(route.optionalGrants[j])) {
          seen.add(route.optionalGrants[j]);
          if (this.supportsGrant(route.optionalGrants[j])) { grants.push(route.optionalGrants[j]); }
        }
      }
    }
    if (hostArea && !seen.has('native.storage.read')) {
      grants.push('native.storage.read');
    }
    return grants;
  }

  /** Native→page push via the document-start shim; queued until the page attached onmessage. */
  private pushFrame(json: string): void {
    if (this.disposed) { return; }
    if (json.length > BRIDGE_MAX_FRAME_BYTES || utf8Encode(json).length > BRIDGE_MAX_FRAME_BYTES) {
      this.log(`bridge frame exceeds 640KiB cap (${json.length}) — dropped`);
      return;
    }
    if (!this.pushReady) {
      this.pushQueue.push(json);
      return;
    }
    this.deliverPush(json);
  }

  private deliverPush(json: string): void {
    let js = `window.__orcaNativePush(${JSON.stringify(json)})`;
    this.controller.runJavaScript(js).catch(() => {
    });
  }

  /** Called through the injected proxy when the page has set onmessage. */
  onPushChannelReady(): void {
    this.pushReady = true;
    while (this.pushQueue.length > 0) {
      let frame = this.pushQueue.shift();
      if (frame !== undefined) {
        this.deliverPush(frame);
      }
    }
  }

  /** Page→native frames (window.orcaBridge.postMessage). */
  onClientMessage(json: string): void {
    if (this.disposed || json.length > BRIDGE_MAX_FRAME_BYTES || utf8Encode(json).length > BRIDGE_MAX_FRAME_BYTES) { return; }
    let msg: ESObject;
    try {
      msg = JSON.parse(json) as ESObject;
    } catch (e) {
      this.log('bridge frame is not JSON — dropped');
      return;
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg['v'] !== 1) { return; }
    let type: string = msg['type'];
    if (type === 'ready') {
      this.readDeclaredStorageKeys(msg);
      this.sendInit(); if (this.readySink) { this.readySink(); }
      return;
    }
    if (type === 'request') {
      this.forwardRequest(msg, false);
      return;
    }
    if (type === 'subscribe') {
      this.forwardRequest(msg, true);
      return;
    }
    if (type === 'cancel') {
      this.handleCancel(msg);
      return;
    }
    if (type === 'ack') { this.ackStream(msg['id'], msg['seq']); return; }
    if (type === 'page.console') {
      if (msg['level'] === 'error' || msg['level'] === 'warn') { this.log('Web page reported a diagnostic'); }
      return;
    }
    if (type === 'notify') {
      this.handleNotify(msg);
      return;
    }
    if (type === 'close') {
      this.log('page closed bridge');
      return;
    }
    this.log(`unknown bridge frame type: ${type}`);
  }

  private readDeclaredStorageKeys(msg: ESObject): void {
    this.declaredStorageKeys = [];
    let keysValue: ESObject = msg['storageKeys'];
    if (!Array.isArray(keysValue)) {
      return;
    }
    let keys: Array<string> = keysValue as Array<string>;
    for (let i = 0; i < keys.length; i++) {
      let key: string = keys[i];
      if (typeof key === 'string' && key.length > 0 && key.length <= PAGE_STORAGE_MAX_KEY_CHARS) {
        this.declaredStorageKeys.push(key);
      }
    }
  }

  /** Notify dispatch (bridge-host-notify.ts). One-way frames owe no reply. */
  private handleNotify(msg: ESObject): void {
    let name: string = msg['name'];
    if (name === 'foreground' || name === 'liveness-probe') {
      if (this.probing || this.client.getState() !== 'ready' || Date.now() - this.lastProbeAt < 10000) { return; }
      this.probing = true; this.lastProbeAt = Date.now();
      this.client.request('status.get', null, 5000).then((reply: RpcResponse): void => {
        if (!this.disposed && !(reply instanceof RpcSuccess)) { this.client.close(); }
      }).catch((): void => { if (!this.disposed) { this.client.close(); } }).finally((): void => { this.probing = false; });
      return;
    }
    if (name === 'fault') {
      let error: ESObject = msg['error'];
      if (this.faultSink && this.routeGrants().includes('fault') && !this.pageFaulted
        && error && typeof error === 'object' && !Array.isArray(error)
        && typeof error['category'] === 'string' && typeof error['message'] === 'string'
        && typeof error['isRpcDeliveryUnknown'] === 'boolean') {
        this.pageFaulted = true; this.faultSink('The session page failed. Retry to reload it.');
      }
      return;
    }
    if (name === 'externalLink') {
      let target: string = msg['url'];
      if (this.externalLink && this.routeGrants().includes('externalLink') && typeof target === 'string'
        && target.length > 0 && target.length <= 2048 && /^(https?:\/\/|mailto:)/i.test(target) && !/[\x00-\x20]/.test(target)) {
        this.externalLink(target).catch((): void => this.log('Unable to open external link'));
      }
      return;
    }
    if (name === 'native.haptics.trigger') {
      let kind: string = msg['kind'];
      if (this.haptics && this.routeGrants().includes('haptics') && ['mediumImpact', 'selection', 'success', 'error', 'edgeBump'].includes(kind)) {
        this.haptics(kind).catch((): void => {});
      }
      return;
    }
    if (name === 'route-param-clear') {
      let param: string = msg['param']; let value: string = msg['value'];
      if (['paneKey', 'open'].includes(param) && typeof value === 'string' && this.routeParams[param] === value) {
        let next: Record<string, string> = {};
        let keys = Object.keys(this.routeParams);
        for (let i = 0; i < keys.length; i++) { if (keys[i] !== param) { next[keys[i]] = this.routeParams[keys[i]]; } }
        this.routeParams = next;
      }
      return;
    }
    if (name === 'storage') {
      this.handleStorageNotify(msg);
      return;
    }
    if (name === 'terminalViewport') {
      this.handleTerminalViewportNotify(msg);
      return;
    }
    if (name === 'navigate-back') { if (this.onBack) { this.onBack(false); } return; }
    if (name === 'back-claim') { this.backClaimed = msg['claimed'] === true; return; }
    if (name === 'painted') { if (this.onPaint) { this.onPaint(); } return; }
    if (name === 'navigate' || name === 'location') {
      this.handleRouteNotify(name === 'navigate', msg['href'], msg['replace'] === true);
      return;
    }
    this.log(`notify: ${name}`);
  }

  private handleRouteNotify(navigate: boolean, href: string, replace: boolean): void {
    if (typeof href !== 'string' || href.length > 2048 || /[\\#\s\x00-\x1f\x7f]/.test(href)) { return; }
    if (navigate && !this.routeGrants().includes('navigate')) { return; }
    if (navigate && href === '/') { if (this.onBack) { this.onBack(true); } return; }
    let queryAt = href.indexOf('?');
    let pathname = queryAt >= 0 ? href.substring(0, queryAt) : href;
    let params = this.readRouteQuery(queryAt >= 0 ? href.substring(queryAt + 1) : '');
    if (params === null) { return; }
    let hostPath = `/h/${this.meta.id}`;
    if (pathname === `${hostPath}/edit`) {
      if (navigate && queryAt < 0 && this.nativeNavigation) { this.nativeNavigation('edit-host', replace); }
      return;
    }
    if (pathname === '/connection-log') {
      if (navigate && params['hostId'] === this.meta.id && Object.keys(params).length === 1 && this.nativeNavigation) {
        this.nativeNavigation('connection-log', replace);
      }
      return;
    }
    if (pathname !== hostPath && !pathname.startsWith(`${hostPath}/`)) { return; }
    if (!this.acceptsLocationPath(pathname)) { return; }
    this.routePathname = pathname;
    this.routeParams = params;
    if (this.locationSink) { this.locationSink(pathname, params); }
  }

  private readRouteQuery(query: string): Record<string, string> | null {
    let params: Record<string, string> = {};
    if (query.length === 0) { return params; }
    let pairs = query.split('&');
    if (pairs.length > 32) { return null; }
    try {
      for (let i = 0; i < pairs.length; i++) {
        let at = pairs[i].indexOf('=');
        let key = decodeURIComponent(at < 0 ? pairs[i] : pairs[i].substring(0, at));
        let value = decodeURIComponent(at < 0 ? '' : pairs[i].substring(at + 1));
        if (!key || ['__proto__', 'constructor', 'prototype'].includes(key) || params[key] !== undefined) { return null; }
        params[key] = value;
      }
      return params;
    } catch (e) { return null; }
  }

  private acceptsLocationPath(pathname: string): boolean {
    let parts = pathname.split('/');
    try {
      for (let i = 1; i < parts.length; i++) {
        let decoded = decodeURIComponent(parts[i]);
        if (!decoded || decoded === '.' || decoded === '..' || /[\x00-\x1f\x7f]/.test(decoded)) { return false; }
        if (!/[\\/ ]/.test(decoded)) { continue; }
        // Workspace IDs carry an absolute path, but the encoded segment stays opaque to routing.
        let opaque = this.manifest.routes.some((route: BundleRoute): boolean =>
          route.pathname.split('/')[i] === '[worktreeId]' && this.routeMatches(route.pathname, pathname));
        if (!opaque) { return false; }
      }
      return true;
    } catch (e) { return false; }
  }

  // ===== Page storage (page-storage-keys.ts rules, in-memory store) =====

  private isPageStorageKey(key: string): boolean {
    if (key.length > PAGE_STORAGE_MAX_KEY_CHARS) {
      return false;
    }
    for (let i = 0; i < PAGE_STORAGE_EXACT_KEYS.length; i++) {
      if (PAGE_STORAGE_EXACT_KEYS[i] === key) {
        return true;
      }
    }
    for (let i = 0; i < PAGE_STORAGE_KEY_PREFIXES.length; i++) {
      let prefix = PAGE_STORAGE_KEY_PREFIXES[i];
      if (key.startsWith(prefix) && key.length > prefix.length) {
        return true;
      }
    }
    return false;
  }

  /** Workspace scope derived from the route (/h/<host>/session/<worktree>); see pageRouteWorkspace. */
  private pageRouteWorkspace(): string | null {
    let segments = this.routePathname.split('/');
    if (segments.length !== 5 || segments[0] !== '' || segments[1] !== 'h' || segments[3] !== 'session') {
      return null;
    }
    let hostId = '';
    let worktreeId = '';
    try {
      hostId = decodeURIComponent(segments[2]);
      worktreeId = decodeURIComponent(segments[4]);
    } catch (e) {
      return null;
    }
    if (hostId.length === 0 || worktreeId.length === 0) {
      return null;
    }
    return `${hostId}|${worktreeId}`;
  }

  /** pageStorageKeysForRoute: exact keys + this host's pins key + workspace-scoped keys. */
  private isPageStorageKeyForRoute(key: string): boolean {
    if (!this.isPageStorageKey(key)) {
      return false;
    }
    for (let i = 0; i < PAGE_STORAGE_EXACT_KEYS.length; i++) {
      if (PAGE_STORAGE_EXACT_KEYS[i] === key) {
        return true;
      }
    }
    if (key === `orca:pins:${this.meta.id}`) {
      return true;
    }
    let workspace = this.pageRouteWorkspace();
    if (workspace === null) {
      return false;
    }
    let parts = workspace.split('|');
    if (parts[0] !== this.meta.id) {
      return false;
    }
    let scope = `${encodeURIComponent(this.meta.id)}:${encodeURIComponent(parts[1])}`;
    let scopedPrefixes: string[] = ['orca:nativeChatTabs:', 'orca:terminalLiveInputDisabled:', 'orca:terminalDrafts:'];
    for (let i = 0; i < scopedPrefixes.length; i++) {
      let prefix = scopedPrefixes[i];
      if (key.startsWith(prefix + scope) && key.length > prefix.length + scope.length) {
        return true;
      }
    }
    return false;
  }

  /** Host-area pages reach this host's other workspaces too (isHostWorkspaceStorageKey). */
  private isHostWorkspaceStorageKey(key: string): boolean {
    if (!this.isPageStorageKey(key)) {
      return false;
    }
    let scope = `${encodeURIComponent(this.meta.id)}:`;
    let prefixes: string[] = ['orca:nativeChatTabs:', 'orca:terminalLiveInputDisabled:', 'orca:terminalDrafts:'];
    for (let i = 0; i < prefixes.length; i++) {
      let prefix = prefixes[i];
      if (key.startsWith(prefix + scope) && key.length > prefix.length + scope.length) {
        return true;
      }
    }
    return false;
  }

  private pageReadsStorageKey(key: string): boolean {
    if (key !== NEGOTIATED_PAGE_STORAGE_KEY) {
      return true;
    }
    return this.declaredStorageKeys.includes(key);
  }

  private handleStorageNotify(msg: ESObject): void {
    let key: string = msg['key'];
    let valueValue: ESObject = msg['value'];
    let value: string | null = typeof valueValue === 'string' ? valueValue : null;
    let hostArea = this.ownsHostArea();
    if (typeof key !== 'string'
      || key.length === 0
      || key.length > PAGE_STORAGE_MAX_KEY_CHARS
      || !(this.isPageStorageKeyForRoute(key) || (hostArea && this.isHostWorkspaceStorageKey(key)))
      || this.oversizeKeys.has(key)
      || (value !== null && value.length > PAGE_STORAGE_MAX_VALUE_CHARS)) {
      this.log(`storage refused: ${key}`);
      return;
    }
    try {
      if (value !== null && !this.pageStorage.has(key) && this.pageStorage.size >= 512) { throw new Error('storage full'); }
      if (this.storageStore) { this.storageStore.write(key, value); }
    } catch (e) { this.log('无法保存会话状态，请检查设备存储空间'); return; }
    if (value === null) {
      this.pageStorage.delete(key);
      this.log(`storage delete ok: ${key}`);
      return;
    }
    this.pageStorage.set(key, value);
    this.log(`storage write ok: ${key} (${value.length} chars)`);
  }

  // ===== Terminal viewport (bridge-host-notify.ts → terminal stream control frames) =====

  private handleTerminalViewportNotify(msg: ESObject): void {
    let terminal: string = msg['terminal'];
    let cols: number = msg['cols'];
    let rows: number = msg['rows'];
    if (typeof terminal !== 'string' || terminal.length === 0
      || typeof cols !== 'number' || typeof rows !== 'number') {
      this.log('terminalViewport refused: malformed params');
      return;
    }
    let intCols = Math.floor(cols);
    let intRows = Math.floor(rows);
    if (intCols < 1 || intCols > BRIDGE_MAX_VIEWPORT_COLS || intRows < 1 || intRows > BRIDGE_MAX_VIEWPORT_ROWS) {
      this.log(`terminalViewport refused: ${intCols}x${intRows} out of bounds`);
      return;
    }
    // Update the stored params so replays carry the viewport, like the upstream
    // shell's updateTerminalSubscriptionViewport.
    this.terminalSubs.forEach((record: TerminalSubscriptionRecord, bridgeId: string) => {
      if (record.terminal !== terminal) {
        return;
      }
      let streamId = this.streamIdForBridgeId(bridgeId);
      if (streamId === null) {
        this.log(`terminalViewport ${terminal} ${intCols}x${intRows}: no stream id yet for ${bridgeId}`);
        return;
      }
      // Claim then Resize (remote-runtime-terminal-multiplexer.claimViewport): new hosts
      // get precise ownership; hosts that ignore Claim still receive the Resize. seq 0.
      let payload = encodeViewportJson(intCols, intRows);
      let claimed = this.client.sendBinaryRaw(encodeTerminalFrame(OP_CLAIM_VIEWPORT, streamId, 0, payload));
      let resized = this.client.sendBinaryRaw(encodeTerminalFrame(OP_RESIZE, streamId, 0, payload));
      this.log(`terminalViewport ${terminal} ${intCols}x${intRows} → stream ${streamId} claim=${claimed} resize=${resized}`);
    });
  }

  private streamIdForBridgeId(bridgeId: string): number | null {
    let found: number | null = null;
    this.streamIds.forEach((value: string, key: number) => {
      if (value === bridgeId) {
        found = key;
      }
    });
    return found;
  }

  // ===== Request/subscribe forwarding =====

  /** Request/subscribe forwarding: the bridge id IS the wire id, so replies/events route back. */
  private forwardRequest(msg: ESObject, streaming: boolean): void {
    let id: string = msg['id'];
    let method: string = msg['method'];
    if (typeof id !== 'string' || typeof method !== 'string') {
      return;
    }
    if (id.length === 0 || id.length > 128 || this.pendingIds.has(id) || this.subscriptions.has(id)) {
      this.sendError(id, 'request id unavailable'); return;
    }
    if (method.startsWith('native.')) { this.serveNativeRequest(msg, id, method, streaming); return; }
    let paramsValue: ESObject = this.substitutePageClientIdentity(msg['params']);
    let wire = this.buildForwardWire(msg, id, method, paramsValue);
    if (wire.length === 0) { this.sendError(id, 'invalid envelope'); return; }
    if (streaming) {
      if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        this.sendError(id, 'too-many-subscriptions');
        return;
      }
      if (method === 'browser.screencast' && msg['wantsBinary'] === true && this.routeGrants().includes('screencastBinary')) {
        if (this.binarySubscriptions.size > 0) { this.sendError(id, 'screencast already active'); return; }
        this.binarySubscriptions.add(id);
      }
      let record: DesktopSubscriptionRecord = { method: method, params: paramsValue, envelope: msg['envelope'], readyId: '', cancelled: false };
      this.desktopSubs.set(id, record);
      this.subscriptions.add(id);
      let window: StreamWindow = { outstanding: [], bytes: 0, backlog: [], backlogBytes: 0 };
      this.streamWindows.set(id, window);
      this.seq.set(id, 0);
      this.log(`→ ${method} (subscribe ${id})`);
      if (method === 'terminal.subscribe') {
        this.rememberTerminalSubscription(id, paramsValue);
      }
      let sent = this.client.subscribeWithId(id, wire, (responseJson: string): void => {
        this.noteDesktopSubscription(id, responseJson);
        if (!this.subscriptions.has(id)) { return; }
        this.rememberStreamId(id, responseJson);
        this.forwardEvent(id, responseJson);
      });
      if (!sent) { this.subscriptions.delete(id); this.desktopSubs.delete(id); this.binarySubscriptions.delete(id); this.streamWindows.delete(id); this.seq.delete(id); this.sendError(id, 'channel unavailable'); }
    } else {
      if (this.pendingIds.size >= MAX_PENDING_REQUESTS) { this.sendError(id, 'request limit'); return; }
      this.pendingIds.add(id);
      this.log(`→ ${method} (${id})`);
      let options: ESObject = msg['options'];
      let timeout: number = options && typeof options['timeoutMs'] === 'number' ? options['timeoutMs'] : 30000;
      this.client.requestRaw(id, wire, timeout).then((response: RpcResponse) => {
        if (!this.pendingIds.delete(id) || this.disposed) { return; }
        this.sendReply(id, response);
      }).catch(() => { if (this.pendingIds.delete(id)) { this.sendError(id, 'send-failed'); } });
    }
  }

  private buildForwardWire(msg: ESObject, id: string, method: string, params: ESObject): string {
    let wire: Record<string, Object> = {};
    let envelope: ESObject = msg['envelope'];
    if (envelope !== undefined) {
      if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) { return ''; }
      let keys = Object.keys(envelope);
      for (let i = 0; i < keys.length; i++) {
        let key = keys[i];
        if (['id', 'deviceToken', 'method', 'params', '__proto__', 'constructor', 'prototype'].includes(key)) { continue; }
        wire[key] = envelope[key];
      }
    }
    wire['id'] = id; wire['deviceToken'] = this.client.deviceToken; wire['method'] = method;
    if (params !== undefined && params !== null) { wire['params'] = params; }
    return JSON.stringify(wire);
  }

  /**
   * Swap the page's identity placeholder for the socket's authenticated token
   * (bridge-page-client-identity.ts): the desktop compares params.client.id with the
   * connection's principal (device.token) before granting input sessions/floors.
   */
  private substitutePageClientIdentity(paramsValue: ESObject): ESObject {
    if (paramsValue === undefined || paramsValue === null) {
      return paramsValue;
    }
    try {
      let token = this.client.deviceToken;
      if (token.length === 0) {
        return paramsValue;
      }
      let params = paramsValue as Record<string, Object>;
      let clientField: Object = params['client'];
      if (clientField !== null && clientField !== undefined && typeof clientField === 'object') {
        let clientRec = clientField as Record<string, Object>;
        if (clientRec['id'] === 'orca-page-client') {
          clientRec['id'] = token;
        }
      }
      let mobileField: Object = params['mobileClient'];
      if (mobileField !== null && mobileField !== undefined && typeof mobileField === 'object') {
        let mobileRec = mobileField as Record<string, Object>;
        if (mobileRec['id'] === 'orca-page-client') {
          mobileRec['id'] = token;
        }
      }
    } catch (e) {
      // leave params untouched on shape surprises; the desktop will refuse invalid ones
    }
    return paramsValue;
  }

  /** Remember params.terminal so terminalViewport notifies can find this subscription. */
  private rememberTerminalSubscription(bridgeId: string, paramsValue: ESObject): void {
    if (paramsValue === undefined || paramsValue === null) {
      return;
    }
    try {
      let params = paramsValue as Record<string, Object>;
      let terminal: Object = params['terminal'];
      if (typeof terminal === 'string' && terminal.length > 0) {
        this.terminalSubs.set(bridgeId, { bridgeId: bridgeId, terminal: terminal });
      }
    } catch (e) {
      // malformed params — desktop will refuse the subscribe
    }
  }

  /** Phone-only native verbs are served on-device; the desktop never sees them. */
  private serveNativeRequest(msg: ESObject, id: string, method: string, streaming: boolean): void {
    if (streaming) { this.sendLocalNativeError(id, 'native_verb_not_a_stream', 'Native methods are not streams'); return; }
    if (method === 'native.store.rows') {
      if (!this.routeGrants().includes(method)) { this.sendLocalNativeError(id, 'native_verb_ungranted', 'Device store not granted'); return; }
      if (!this.storageStore) { this.sendLocalNativeError(id, 'native_verb_failed', 'Device store unavailable'); return; }
      if (this.pendingIds.size >= MAX_PENDING_REQUESTS) { this.sendError(id, 'request limit'); return; }
      this.pendingIds.add(id);
      try {
        this.storageStore.rows(msg['params']).then((result: Object): void => {
          if (this.pendingIds.delete(id) && !this.disposed) { this.sendReply(id, new RpcSuccess(id, JSON.stringify(result))); }
        }).catch((): void => {
          if (this.pendingIds.delete(id)) { this.sendLocalNativeError(id, 'native_verb_params', 'Invalid device store request'); }
        });
      } catch (e) { this.pendingIds.delete(id); this.sendLocalNativeError(id, 'native_verb_params', 'Invalid device store request'); }
      return;
    }
    if (this.nativeHandler && this.nativeMethods.includes(method) && !streaming && this.routeGrants().includes(method)) {
      if (this.pendingIds.size >= MAX_PENDING_REQUESTS) { this.sendError(id, 'request limit'); return; }
      this.pendingIds.add(id);
      let handler = this.nativeHandler;
      handler(method, msg['params']).then((result: Object): void => {
        if (this.pendingIds.delete(id) && !this.disposed) { this.sendReply(id, new RpcSuccess(id, JSON.stringify(result))); }
      }).catch((_e: Error): void => {
        if (this.pendingIds.delete(id)) { this.sendLocalNativeError(id, 'native_verb_failed', '设备操作未完成，请检查权限后重试'); }
      });
      return;
    }
    if (method !== 'native.storage.read') {
      // Known phone-only verbs beyond this phase (clipboard/media/audio/...) fail
      // visibly instead of leaking the call to the desktop.
      this.log(`native verb not served on-device: ${method}`);
      this.sendLocalNativeError(id, 'native_verb_failed', `${method} could not be served on this device`);
      return;
    }
    let granted = this.routeGrants().includes('native.storage.read');
    if (!granted) {
      this.sendLocalNativeError(id, 'native_verb_ungranted', 'the page was not granted native.storage.read');
      return;
    }
    let key = '';
    let paramsValue: ESObject = msg['params'];
    if (paramsValue !== undefined && paramsValue !== null) {
      let params = paramsValue as Record<string, Object>;
      let keyValue: Object = params['key'];
      if (typeof keyValue === 'string') {
        key = keyValue;
      }
    }
    if (key.length === 0 || key.length > PAGE_STORAGE_MAX_KEY_CHARS) {
      this.sendLocalNativeError(id, 'native_verb_params', 'native.storage.read was called with params it does not take');
      return;
    }
    let value = this.pageStorage.get(key);
    let valueJson = value === undefined ? 'null' : JSON.stringify(value);
    let payload = `{"id":${JSON.stringify(id)},"ok":true,"result":{"value":${valueJson}}}`;
    this.pushReply(id, payload);
    this.log(`native.storage.read ok: ${key}${value === undefined ? ' (miss)' : ''}`);
  }

  private sendLocalNativeError(id: string, code: string, message: string): void {
    let payload = `{"id":${JSON.stringify(id)},"ok":false,"error":{"code":${JSON.stringify(code)},"message":${JSON.stringify(message)}}}`;
    this.pushReply(id, payload);
  }

  private handleCancel(msg: ESObject): void {
    let cancelId: string = msg['id'];
    this.pendingIds.delete(cancelId);
    if (!this.desktopSubs.has(cancelId)) { this.client.cancelById(cancelId); }
    let stale: number[] = [];
    this.streamIds.forEach((value: string, key: number) => {
      if (value === cancelId) {
        stale.push(key);
      }
    });
    for (let i = 0; i < stale.length; i++) {
      this.streamIds.delete(stale[i]);
      this.snapshots.delete(stale[i]);
    }
    this.terminalSubs.delete(cancelId);
    this.releaseDesktopSubscription(cancelId);
    this.subscriptions.delete(cancelId); this.binarySubscriptions.delete(cancelId); this.streamWindows.delete(cancelId); this.seq.delete(cancelId);
  }

  private noteDesktopSubscription(id: string, json: string): void {
    let record = this.desktopSubs.get(id);
    if (!record) { return; }
    try {
      let reply: ESObject = JSON.parse(json);
      if (reply['ok'] === false) {
        this.desktopSubs.delete(id); this.binarySubscriptions.delete(id);
        this.subscriptions.delete(id); this.client.cancelById(id);
        this.pushFrame(`{"v":1,"type":"end","id":${JSON.stringify(id)},"reason":"closed"}`);
        return;
      }
      let result: ESObject = reply['result'];
      if (result && typeof result['subscriptionId'] === 'string') { record.readyId = result['subscriptionId']; }
      if (record.cancelled && record.readyId.length > 0) { this.releaseDesktopSubscription(id); }
    } catch (e) { }
  }

  private releaseDesktopSubscription(id: string): void {
    let record = this.desktopSubs.get(id);
    if (!record) { return; }
    record.cancelled = true;
    let params: Record<string, Object> = {};
    let method = '';
    let source: ESObject = record.params;
    if (record.method === 'terminal.subscribe' && source && typeof source['terminal'] === 'string') {
      let client: ESObject = source['client'];
      let clientId: string = client && typeof client['id'] === 'string' ? client['id'] : '';
      params['subscriptionId'] = clientId ? `${source['terminal']}:${clientId}` : source['terminal'];
      params['requestId'] = id;
      if (clientId) { let identity: Record<string, string> = { 'id': clientId }; params['client'] = identity; }
      method = 'terminal.unsubscribe';
    } else if (record.method === 'session.tabs.subscribeAll') {
      method = 'session.tabs.unsubscribeAll'; params['subscriptionId'] = id;
    } else if (record.method === 'session.tabs.subscribe' && source && typeof source['worktree'] === 'string') {
      method = 'session.tabs.unsubscribe'; params['worktree'] = source['worktree']; params['subscriptionId'] = id;
    } else if (record.method === 'agentSession.subscribe' && source && typeof source['sessionId'] === 'string') {
      method = 'agentSession.unsubscribe'; params['sessionId'] = source['sessionId']; params['subscriptionId'] = id;
    } else if (record.method === 'nativeChat.subscribe' && source && typeof source['subscriptionId'] === 'string') {
      method = 'nativeChat.unsubscribe'; params['subscriptionId'] = source['subscriptionId'];
    } else if (['browser.screencast', 'runtime.clientEvents.subscribe', 'notifications.subscribe', 'accounts.subscribe'].includes(record.method)) {
      if (!record.readyId) { return; }
      method = record.method === 'browser.screencast' ? 'browser.screencast.unsubscribe' : record.method.replace('.subscribe', '.unsubscribe');
      params['subscriptionId'] = record.readyId;
    }
    this.desktopSubs.delete(id); this.client.cancelById(id);
    if (!method) { return; }
    this.unsubscribeCounter++;
    let requestId = `unsub-${this.unsubscribeCounter}-${Date.now()}`;
    let message: Record<string, Object> = { 'envelope': record.envelope };
    let wire = this.buildForwardWire(message, requestId, method, params);
    if (wire.length > 0) { this.client.requestRaw(requestId, wire).catch((): void => {}); }
  }

  private sendInit(): void {
    let grants = this.routeGrants();
    let pageRoutes: string[] = [];
    for (let i = 0; i < this.manifest.routes.length; i++) {
      pageRoutes.push(this.manifest.routes[i].pathname);
    }
    let connection: BridgeConnectionSnapshot = {
      state: 'connected',
      reconnectAttempt: 0,
      lastConnectedAt: Date.now(),
      lastInboundAt: Date.now(),
      generation: 1,
      activePath: this.connectionPath
    };
    let rpcGrants: BridgeRpcGrants = {
      maxPendingRequests: MAX_PENDING_REQUESTS,
      maxSubscriptions: MAX_SUBSCRIPTIONS
    };
    let grantsValue: BridgeGrantsWire = {
      rpc: rpcGrants,
      native: grants
    };
    let route: BridgeRouteWire = {
      pathname: this.routePathname,
      params: this.routeParams
    };
    let hostValue: BridgeInitHostWire = {
      id: this.meta.id,
      name: this.meta.name,
      endpoint: this.meta.endpoint,
      lastConnected: this.meta.lastConnected,
      personalName: this.meta.personalName || undefined,
      lastKnownMachineName: this.meta.machineName || undefined
    };
    // pageStorageEntriesForInit: omit oversize values (they are unwritable), cap entries.
    let storage: Record<string, string> = {};
    let oversize: string[] = [];
    let count = 0;
    this.pageStorage.forEach((value: string, key: string) => {
      if (!this.pageReadsStorageKey(key)) {
        return;
      }
      if (value.length > PAGE_STORAGE_MAX_VALUE_CHARS) {
        oversize.push(key);
        return;
      }
      if (count >= PAGE_STORAGE_MAX_ENTRIES) {
        return;
      }
      storage[key] = value;
      count++;
    });
    let init: BridgeInitWire = {
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      sessionId: this.sessionId,
      buildId: this.manifest.buildId,
      connection: connection,
      grants: grantsValue,
      route: route,
      pageRoutes: pageRoutes,
      colorScheme: this.scheme,
      uiLocale: this.locale,
      host: hostValue,
      storage: storage,
      storageOversize: oversize,
      ownsHostArea: this.ownsHostArea(),
      safeAreaInsets: this.safeAreaInsets,
      keyboardInset: this.keyboardInset,
      pageGeometry: this.pageGeometry,
      foldDivision: null
    };
    this.pushFrame(JSON.stringify(init));
    this.log(`init sent (v1) grants=${grants.length} storage=${count}`);
  }

  /**
   * Terminal streams learn their numeric stream id from the streaming replies.
   * terminal.subscribe answers {type:'subscribed', streamId:N}; ready-id streams
   * (session.tabs/agentSession) answer {type:'ready', subscriptionId}.
   */
  private rememberStreamId(id: string, responseJson: string): void {
    try {
      let parsed: Object | null = JSON.parse(responseJson) as Object | null;
      if (parsed === null || typeof parsed !== 'object') {
        return;
      }
      let rec = parsed as Record<string, Object>;
      let resultValue: Object = rec['result'];
      if (resultValue === null || resultValue === undefined || typeof resultValue !== 'object') {
        return;
      }
      let result = resultValue as Record<string, Object>;
      let subscriptionId: Object = result['subscriptionId'];
      if (typeof subscriptionId === 'number') {
        this.streamIds.set(subscriptionId, id);
      }
      let streamId: Object = result['streamId'];
      if (typeof streamId === 'number') {
        // Replace any prior mapping: a re-subscribed terminal must own this bridge id.
        this.streamIds.set(streamId, id);
      }
    } catch (e) {
      // non-JSON streaming frame — ignore
    }
  }

  private nextSeq(id: string): number {
    let current = this.seq.get(id) ?? 0;
    this.seq.set(id, current + 1);
    return current;
  }

  /**
   * Bridge event payload is the desktop result VALUE (bridge-host-subscriptions.deliver),
   * not the raw wire frame: the page's stream listeners dispatch on result.type.
   */
  private forwardEvent(id: string, responseJson: string): void {
    let payloadJson: string;
    try {
      let parsed: Object | null = JSON.parse(responseJson) as Object | null;
      let rec = parsed === null ? null : parsed as Record<string, Object>;
      let okValue: Object | null = rec === null ? null : rec['ok'];
      let resultValue: Object | undefined = rec === null ? undefined : rec['result'];
      if (rec !== null && okValue === false) {
        let errorValue: Object = rec['error'];
        let message = 'stream failed';
        if (errorValue !== null && errorValue !== undefined && typeof errorValue === 'object') {
          let error = errorValue as Record<string, Object>;
          let messageValue: Object = error['message'];
          if (typeof messageValue === 'string') {
            message = messageValue;
          }
        }
        let errorResult: Record<string, Object> = {
          'type': 'error',
          'message': message
        };
        payloadJson = JSON.stringify(errorResult);
      } else if (resultValue === undefined || resultValue === null) {
        payloadJson = 'null';
      } else {
        payloadJson = JSON.stringify(resultValue);
      }
    } catch (e) {
      payloadJson = 'null';
    }
    let seq = this.nextSeq(id);
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"event","id":${JSON.stringify(id)},"seq":${seq},"payload":${payloadJson}}`;
    this.pushStreamFrame(id, seq, frame, false);
  }

  private sendReply(id: string, response: RpcResponse): void {
    if (!(response instanceof RpcSuccess) && response.wire.length === 0 && ['timeout', 'closed'].includes(response.errorCode)) {
      this.sendError(id, 'Request delivery could not be confirmed', true); return;
    }
    let payloadJson: string;
    if (response instanceof RpcSuccess) {
      payloadJson = `{"id":${JSON.stringify(response.id)},"ok":true,"result":${response.result}}`;
    } else {
      let failure = response as Object as Record<string, string>;
      payloadJson = `{"id":${JSON.stringify(failure['id'])},"ok":false,"error":{"code":${JSON.stringify(failure['errorCode'])},"message":${JSON.stringify(failure['errorMessage'])}}}`;
    }
    this.pushReply(id, response.wire.length > 0 ? response.wire : payloadJson);
  }

  private pushStreamFrame(id: string, seq: number, json: string, binary: boolean): void {
    let window = this.streamWindows.get(id);
    if (!window || !this.subscriptions.has(id)) { return; }
    let bytes = utf8Encode(json).length;
    if (bytes > BRIDGE_MAX_FRAME_BYTES) {
      if (!binary) { this.overflowStream(id); }
      return;
    }
    let frame: StreamWindowFrame = { seq: seq, bytes: bytes, json: json };
    if (window.outstanding.length < 256 && window.bytes + bytes <= 4 * 1024 * 1024 && window.backlog.length === 0) {
      window.outstanding.push(frame); window.bytes += bytes; this.pushFrame(json); return;
    }
    if (binary) { return; }
    if (this.terminalSubs.has(id) && window.backlogBytes + bytes <= 4 * 1024 * 1024) {
      window.backlog.push(frame); window.backlogBytes += bytes; return;
    }
    this.overflowStream(id);
  }
  private ackStream(id: string, seq: number): void {
    if (typeof id !== 'string' || !Number.isSafeInteger(seq) || seq < 0) { return; }
    let window = this.streamWindows.get(id);
    if (!window || window.outstanding.length === 0 || seq > window.outstanding[window.outstanding.length - 1].seq) { return; }
    while (window.outstanding.length > 0 && window.outstanding[0].seq <= seq) {
      let frame = window.outstanding.shift(); if (frame) { window.bytes -= frame.bytes; }
    }
    while (window.backlog.length > 0 && window.outstanding.length < 256 && window.bytes + window.backlog[0].bytes <= 4 * 1024 * 1024) {
      let frame = window.backlog.shift();
      if (!frame) { break; }
      window.backlogBytes -= frame.bytes; window.outstanding.push(frame); window.bytes += frame.bytes; this.pushFrame(frame.json);
    }
  }
  private overflowStream(id: string): void {
    let cancel: Record<string, string> = { 'id': id }; this.handleCancel(cancel);
    this.pushFrame(`{"v":1,"type":"end","id":${JSON.stringify(id)},"reason":"overflow"}`);
  }

  private pushReply(id: string, payload: string): void {
    if (utf8Encode(payload).length > 8 * 1024 * 1024) { this.sendError(id, 'reply-too-large'); return; }
    let head = `{"v":1,"type":"reply","id":${JSON.stringify(id)},`;
    let whole = `${head}"payload":${payload}}`;
    if (utf8Encode(whole).length <= BRIDGE_MAX_FRAME_BYTES) { this.pushFrame(whole); return; }
    let chunks: string[] = [];
    for (let start = 0; start < payload.length;) {
      let end = Math.min(payload.length, start + BRIDGE_MAX_FRAME_BYTES);
      if (end < payload.length && payload.charCodeAt(end - 1) >= 0xd800 && payload.charCodeAt(end - 1) <= 0xdbff) { end--; }
      let escaped = JSON.stringify(payload.substring(start, end));
      while (utf8Encode(escaped).length + utf8Encode(head).length + 64 > BRIDGE_MAX_FRAME_BYTES) {
        let bytes = utf8Encode(escaped).length + utf8Encode(head).length + 64;
        end = start + Math.max(1, Math.min(end - start - 1, Math.floor((end - start) * BRIDGE_MAX_FRAME_BYTES / bytes)));
        if (end < payload.length && payload.charCodeAt(end - 1) >= 0xd800 && payload.charCodeAt(end - 1) <= 0xdbff) { end--; }
        escaped = JSON.stringify(payload.substring(start, end));
      }
      chunks.push(escaped); start = end;
    }
    if (chunks.length > 27) { this.sendError(id, 'reply-too-large'); return; }
    for (let i = 0; i < chunks.length; i++) {
      this.pushFrame(`${head}"part":{"i":${i},"of":${chunks.length}},"chunk":${chunks[i]}}`);
    }
  }

  private onScreencastBinary(bytes: Uint8Array): void {
    if (this.disposed || bytes.length < 16 || bytes[1] !== 1 || bytes[2] !== 1 || ![1, 2].includes(bytes[3])) { return; }
    let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let metadataLength = view.getUint32(8, true);
    if (view.getUint32(12, true) !== 0 || metadataLength > 16384 || 16 + metadataLength > bytes.length) { return; }
    if (this.binarySubscriptions.size !== 1 || bytes.length > 480 * 1024) { return; }
    try {
      let metadata = JSON.parse(utf8Decode(bytes.subarray(16, 16 + metadataLength))) as Record<string, Object>;
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) { return; }
      let fields = ['offsetTop', 'pageScaleFactor', 'deviceWidth', 'deviceHeight', 'imageWidth', 'imageHeight', 'scrollOffsetX', 'scrollOffsetY', 'timestamp'];
      let checked: Record<string, number> = {};
      for (let i = 0; i < fields.length; i++) {
        let value = metadata[fields[i]];
        if (typeof value === 'number' && Number.isFinite(value)) { checked[fields[i]] = value; }
      }
      let binary: Record<string, Object> = { 'b64': base64Encode(bytes.subarray(16 + metadataLength)), 'format': bytes[3] === 1 ? 'jpeg' : 'png', 'frameSeq': view.getUint32(4, true), 'metadata': checked };
      this.binarySubscriptions.forEach((id: string): void => {
        let event: Record<string, Object> = { 'v': 1, 'type': 'event', 'id': id, 'seq': this.nextSeq(id), 'binary': binary };
        this.pushStreamFrame(id, event['seq'] as number, JSON.stringify(event), true);
      });
    } catch (e) { }
  }

  private sendError(id: string, message: string, deliveryUnknown: boolean = false): void {
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"error","id":${JSON.stringify(id)},"error":{"category":"Error","message":${JSON.stringify(message)},"isRpcDeliveryUnknown":${deliveryUnknown}}}`;
    this.pushFrame(frame);
  }

  /** Connection-state transitions surfaced to the page. */
  publishState(state: string, reconnectAttempt: number): void {
    let connection: BridgeConnectionSnapshot = {
      state: state,
      reconnectAttempt: reconnectAttempt,
      lastConnectedAt: Date.now(),
      lastInboundAt: 0,
      generation: 1,
      activePath: this.connectionPath
    };
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"state","connection":${JSON.stringify(connection)}}`;
    this.pushFrame(frame);
  }

  /** Stream ended (socket closed) — notify every live subscription. */
  notifyStreamsEnded(): void {
    this.seq.clear();
    this.subscriptions.forEach((id: string) => {
      let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"end","id":${JSON.stringify(id)},"reason":"closed"}`;
      this.pushFrame(frame);
    });
    this.subscriptions.clear(); this.binarySubscriptions.clear(); this.streamWindows.clear();
    this.streamIds.clear();
    this.snapshots.clear();
    this.terminalSubs.clear(); this.desktopSubs.clear();
  }
}
