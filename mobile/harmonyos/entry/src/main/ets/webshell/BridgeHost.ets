import { PageStorageStore } from '../storage/PageStorageStore';
import { webview } from '@kit.ArkWeb';
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
const MAX_SUBSCRIPTIONS = 64;
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

interface BridgeInitHostWire {
  id: string;
  name: string;
  endpoint: string;
  lastConnected: number;
}

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
}

/** A forwarded terminal.subscribe: the handle its params named, for viewport routing. */
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
  private seq: Map<string, number> = new Map();
  private streamIds: Map<number, string> = new Map();
  private snapshots: Map<number, TerminalSnapshotState> = new Map();
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
  private scheme: string = 'dark';

  setStorage(store: PageStorageStore): void { this.storageStore = store; this.pageStorage = store.entries(); }
  setColorScheme(scheme: string): void { this.scheme = scheme; }
  setNativeHandler(methods: string[], handler: (method: string, params: ESObject) => Promise<Object>): void {
    this.nativeMethods = methods; this.nativeHandler = handler;
  }
  setNavigation(back: (home: boolean) => void, paint: () => void): void { this.onBack = back; this.onPaint = paint; }
  getRoute(): string { return this.routePathname; }
  handleBack(): boolean {
    if (!this.backClaimed || this.disposed) { return false; }
    this.pushFrame('{"v":1,"type":"back"}'); return true;
  }
  dispose(): void {
    if (this.disposed) { return; }
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
      this.onTerminalBinary(bytes);
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
    this.pushFrame(frameJson);
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
          if (!route.grants[j].startsWith('native.') || this.nativeMethods.includes(route.grants[j])
            || route.grants[j] === 'native.storage.read') { grants.push(route.grants[j]); }
        }
      }
      for (let j = 0; j < route.optionalGrants.length; j++) {
        if (!seen.has(route.optionalGrants[j])) {
          seen.add(route.optionalGrants[j]);
          if (!route.optionalGrants[j].startsWith('native.') || this.nativeMethods.includes(route.optionalGrants[j])
            || route.optionalGrants[j] === 'native.storage.read') { grants.push(route.optionalGrants[j]); }
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
    if (json.length > BRIDGE_MAX_FRAME_BYTES) {
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
    if (this.disposed || json.length > BRIDGE_MAX_FRAME_BYTES) { return; }
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
      this.sendInit();
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
    if (type === 'ack') {
      return; // no backpressure credit tracking yet; the page paces itself
    }
    if (type === 'page.console') {
      this.log(`page.${msg['level']}: ${msg['text']}`);
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
      let href: string = msg['href'];
      if (name === 'navigate' && href === '/') { if (this.onBack) { this.onBack(true); } return; }
      if (typeof href === 'string' && href.startsWith(`/h/${this.meta.id}`)
        && (href.length === `/h/${this.meta.id}`.length || href.charAt(`/h/${this.meta.id}`.length) === '/')
        && href.length < 2048 && !href.includes('..')) { this.routePathname = href; }
      return;
    }
    this.log(`notify: ${name}`);
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
      this.subscriptions.add(id);
      this.seq.set(id, 0);
      this.log(`→ ${method} (subscribe ${id})`);
      if (method === 'terminal.subscribe') {
        this.rememberTerminalSubscription(id, paramsValue);
      }
      let sent = this.client.subscribeWithId(id, wire, (responseJson: string): void => {
        this.rememberStreamId(id, responseJson);
        this.forwardEvent(id, responseJson);
      });
      if (!sent) { this.subscriptions.delete(id); this.sendError(id, 'channel unavailable'); }
    } else {
      if (this.pendingIds.size >= MAX_PENDING_REQUESTS) { this.sendError(id, 'request limit'); return; }
      this.pendingIds.add(id);
      this.log(`→ ${method} (${id})`);
      let options: ESObject = msg['options'];
      let timeout: number = options && typeof options['timeoutMs'] === 'number' ? options['timeoutMs'] : 15000;
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
    if (method === 'native.pdf.view') {
      // desktop:true upstream — served through the desktop like any request.
      this.forwardRequestPlain(msg, id, method, streaming);
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
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"reply","id":${JSON.stringify(id)},"payload":${payload}}`;
    this.pushFrame(frame);
    this.log(`native.storage.read ok: ${key}${value === undefined ? ' (miss)' : ''}`);
  }

  private forwardRequestPlain(msg: ESObject, id: string, method: string, streaming: boolean): void {
    let paramsValue: ESObject = msg['params'];
    let wire: string;
    if (paramsValue === undefined || paramsValue === null) {
      wire = `{"id":${JSON.stringify(id)},"deviceToken":${JSON.stringify(this.client.deviceToken)},"method":${JSON.stringify(method)}}`;
    } else {
      wire = `{"id":${JSON.stringify(id)},"deviceToken":${JSON.stringify(this.client.deviceToken)},"method":${JSON.stringify(method)},"params":${JSON.stringify(paramsValue)}}`;
    }
    if (streaming) {
      let sent = this.client.subscribeWithId(id, wire, (responseJson: string): void => {
        this.forwardEvent(id, responseJson);
      });
    } else {
      this.client.requestRaw(id, wire).then((response: RpcResponse) => {
        this.sendReply(id, response);
      }).catch(() => {
        this.sendError(id, 'send-failed');
      });
    }
  }

  private sendLocalNativeError(id: string, code: string, message: string): void {
    let payload = `{"id":${JSON.stringify(id)},"ok":false,"error":{"code":${JSON.stringify(code)},"message":${JSON.stringify(message)}}}`;
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"reply","id":${JSON.stringify(id)},"payload":${payload}}`;
    this.pushFrame(frame);
  }

  private handleCancel(msg: ESObject): void {
    let cancelId: string = msg['id'];
    this.pendingIds.delete(cancelId);
    this.client.cancelById(cancelId);
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
    let terminalRecord = this.terminalSubs.get(cancelId);
    if (terminalRecord !== undefined) {
      this.terminalSubs.delete(cancelId);
      // Explicit host teardown (buildRequestStreamUnsubscribe): without it every
      // fit-pass resubscribe would leak a live desktop stream.
      this.sendTerminalUnsubscribe(terminalRecord.terminal, cancelId);
    }
    this.subscriptions.delete(cancelId);
  }

  /** One-shot terminal.unsubscribe naming this exact request id. */
  private sendTerminalUnsubscribe(terminal: string, requestId: string): void {
    this.unsubscribeCounter++;
    let id = `unsub-${this.unsubscribeCounter}-${Date.now()}`;
    let params = `{"subscriptionId":${JSON.stringify(terminal)},"requestId":${JSON.stringify(requestId)}}`;
    let wire = `{"id":${JSON.stringify(id)},"deviceToken":${JSON.stringify(this.client.deviceToken)},"method":"terminal.unsubscribe","params":${params}}`;
    this.client.requestRaw(id, wire).then((_response: RpcResponse): void => {
    }).catch((): void => {
    });
    this.log(`terminal.unsubscribe sent for ${requestId}`);
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
      activePath: 'lan'
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
      params: {}
    };
    let hostValue: BridgeInitHostWire = {
      id: this.meta.id,
      name: this.meta.name,
      endpoint: this.meta.endpoint,
      lastConnected: this.meta.lastConnected
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
      uiLocale: 'en',
      host: hostValue,
      storage: storage,
      storageOversize: oversize,
      ownsHostArea: this.ownsHostArea()
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
    this.pushFrame(frame);
  }

  private sendReply(id: string, response: RpcResponse): void {
    let payloadJson: string;
    if (response instanceof RpcSuccess) {
      payloadJson = `{"id":${JSON.stringify(response.id)},"ok":true,"result":${response.result}}`;
    } else {
      let failure = response as Object as Record<string, string>;
      payloadJson = `{"id":${JSON.stringify(failure['id'])},"ok":false,"error":{"code":${JSON.stringify(failure['errorCode'])},"message":${JSON.stringify(failure['errorMessage'])}}}`;
    }
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"reply","id":${JSON.stringify(id)},"payload":${payloadJson}}`;
    this.pushFrame(frame);
  }

  private sendError(id: string, message: string): void {
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"error","id":${JSON.stringify(id)},"error":{"kind":"unavailable","message":${JSON.stringify(message)}}}`;
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
      activePath: 'lan'
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
    this.subscriptions.clear();
    this.streamIds.clear();
    this.snapshots.clear();
    this.terminalSubs.clear();
  }
}
