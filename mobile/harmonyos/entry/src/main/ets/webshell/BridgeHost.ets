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
import { DesktopAutomationCatalog } from '../transport/DesktopConnections';
import { FoldDivision } from './WindowRegions';
import { NativeMediaTooLargeError } from './NativeDevice';
import { parseTerminalRailClaim, terminalRailKeyEnabled, TerminalRailClaim } from './TerminalRailClaim';

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
const AUTOMATION_CATALOG_VERB = 'native.automation.catalog.read';
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
const PAGE_WORKSPACE_STORAGE_KEY_PREFIXES: string[] = [
  'orca:nativeChatTabs:',
  'orca:terminalLiveInputDisabled:',
  'orca:terminalDrafts:'
];
const PAGE_STORAGE_KEY_PREFIXES: string[] = ['orca:pins:', ...PAGE_WORKSPACE_STORAGE_KEY_PREFIXES];
const NEGOTIATED_PAGE_STORAGE_KEY = 'orca:terminalSplitLayout';
const PAGE_STORAGE_MAX_VALUE_CHARS = 16 * 1024;
const PAGE_STORAGE_MAX_KEY_CHARS = 256;
const PAGE_STORAGE_MAX_ENTRIES = 32;
const TERMINAL_SETTINGS_STORAGE_KEYS: string[] = [
  'orca:terminal-accessory-layout', 'orca:custom-accessory-keys', 'orca:terminalTextScale',
  'orca:terminalAutocompleteEnabled', 'orca:terminalLinkOpenMode'
];
// bridge-caps.ts viewport bounds (terminalViewport notify envelope).
const BRIDGE_MAX_VIEWPORT_COLS = 1000;
const BRIDGE_MAX_VIEWPORT_ROWS = 500;

const RECONNECTABLE_STREAMS = [
  'accounts.subscribe', 'agentSession.subscribe', 'agentSession.subscribeStatus', 'agentSession.subscribeTurnCompletions',
  'browser.screencast', 'files.watch', 'layout.subscribe', 'nativeChat.subscribe', 'notifications.subscribe',
  'runtime.clientEvents.subscribe', 'session.tabs.subscribe', 'session.tabs.subscribeAll',
  'terminal.subscribe', 'terminal.subscribeClaudeAgentViews', 'terminal.multiplex'
];
const SERVER_STREAM_RELEASE: Map<string, string> = new Map([
  ['accounts.subscribe', 'accounts.unsubscribe'],
  ['browser.screencast', 'browser.screencast.unsubscribe'],
  ['files.watch', 'files.unwatch'],
  ['layout.subscribe', 'layout.unsubscribe'],
  ['notifications.subscribe', 'notifications.unsubscribe'],
  ['runtime.clientEvents.subscribe', 'runtime.clientEvents.unsubscribe']
]);

interface BridgeConnectionSnapshot {
  state: string;
  reconnectAttempt: number;
  lastConnectedAt: number | null;
  lastInboundAt: number | null;
  generation: number;
  activePath: string;
  pendingPath?: string;
  relayHostReachability?: string;
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

export type BridgeNativePage = 'edit-host' | 'connection-log' | 'terminal-settings';

interface BridgeInitHostWire {
  personalName?: string;
  lastKnownMachineName?: string;
  lastKnownHostPlatform?: string;
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
  pageRouteGrants: PageRouteGrant[];
  colorScheme: string;
  uiLocale: string;
  host: BridgeInitHostWire;
  storage: Record<string, string>;
  storageOversize: string[];
  refreshTerminalShortcuts?: boolean;
  ownsHostArea: boolean;
  safeAreaInsets: BridgeSafeAreaInsets;
  keyboardInset: number;
  pageGeometry: BridgePageGeometry;
  foldDivision: FoldDivision | null;
  terminalKeyRail: string[];
}

interface PageRouteGrant { pathname: string; grants: string[]; }

/** A forwarded terminal.subscribe: the handle its params named, for viewport routing. */
interface StreamWindowFrame { seq: number; bytes: number; json: string; }
interface StreamWindow { outstanding: StreamWindowFrame[]; bytes: number; backlog: StreamWindowFrame[]; backlogBytes: number; }
interface DesktopSubscriptionRecord { method: string; params: ESObject; envelope: ESObject; readyId: string; cancelled: boolean; }
interface TerminalSubscriptionRecord {
  bridgeId: string;
  terminal: string;
}

let nextBridgeOwner = 0;

export class BridgeHost {
  private client: SpikeRpcClient | null;
  private unbindBinary: (() => void) | null = null;
  private connection: BridgeConnectionSnapshot;
  private controller: webview.WebviewController;
  private manifest: BundleManifest;
  private meta: HostMeta;
  private sessionId: string;
  private routePathname: string;
  private routeParams: Record<string, string> = {};
  private readonly entryPathname: string;
  private requestedOpen: string = '';
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
  private readonly wirePrefix: string = `shell-${++nextBridgeOwner}`;
  private pushQueue: string[] = [];
  private pushReady = false;
  private disposed = false;
  private storageStore: PageStorageStore | null = null;
  private readAutomationCatalog: (() => DesktopAutomationCatalog | null) | null = null;
  private pendingIds: Set<string> = new Set();
  private desktopPending: Set<string> = new Set();
  private backClaimed: boolean = false;
  private backSendPending: boolean = false;
  private backEpoch: number = 0;
  private nativeHandler: ((method: string, params: ESObject) => Promise<Object>) | null = null;
  private nativeMethods: string[] = [];
  private onBack: ((home: boolean) => void) | null = null;
  private desktopListBack: boolean = false;
  private wideLayout: boolean = false;
  private shellNavigation: ((pathname: string, params: Record<string, string>, replace: boolean) => void) | null = null;
  private overlayNavigation: ((pathname: string, params: Record<string, string>) => void) | null = null;
  private overlayNavigated: boolean = false;
  private onPaint: (() => void) | null = null;
  private safeAreaInsets: BridgeSafeAreaInsets = { top: 0, right: 0, bottom: 0, left: 0 };
  private keyboardInset: number = 0;
  private pageGeometry: BridgePageGeometry = { occlusions: [], sideRail: false, directionPadAvailable: false };
  private foldDivision: FoldDivision | null = null;
  private railKeys: string[] = [];
  private railClaim: TerminalRailClaim | null = null;
  private railClaimSink: ((claim: TerminalRailClaim | null) => void) | null = null;
  private railFocused: boolean = false;
  private pageReady: boolean = false;
  private pageReadsAppInactive: boolean = false;
  private readySink: (() => void) | null = null;
  private faultSink: ((message: string) => void) | null = null;
  private livenessSink: (() => void) | null = null;
  private pageFaulted: boolean = false;
  setReadySink(sink: () => void): void { this.readySink = sink; }
  setFaultSink(sink: (message: string) => void): void { this.faultSink = sink; }
  setLivenessSink(sink: () => void): void { this.livenessSink = sink; }
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
  setPageGeometry(value: BridgePageGeometry, fold: FoldDivision | null, railKeys: string[] = []): void {
    if (fold && (!['vertical', 'horizontal'].includes(fold.axis) || !this.validInset(fold.start)
      || !this.validInset(fold.end) || fold.end <= fold.start)) { return; }
    if (!Array.isArray(value.occlusions) || value.occlusions.length > 16 || typeof value.sideRail !== 'boolean'
      || (value.directionPadAvailable !== undefined && typeof value.directionPadAvailable !== 'boolean')
      || value.occlusions.some((rect: BridgePageOcclusion): boolean => ![rect.x, rect.y, rect.width, rect.height].every((coordinate: number): boolean => this.validInset(coordinate)))
      || (JSON.stringify(value) === JSON.stringify(this.pageGeometry) && JSON.stringify(fold) === JSON.stringify(this.foldDivision)
        && JSON.stringify(railKeys) === JSON.stringify(this.railKeys))) { return; }
    this.pageGeometry = value; this.foldDivision = fold; this.railKeys = railKeys;
    if (this.pushReady && !this.disposed) { this.sendInit(); }
  }

  setTerminalRailClaimSink(sink: (claim: TerminalRailClaim | null) => void): void { this.railClaimSink = sink; }
  setTerminalRailFocus(focused: boolean): void { this.railFocused = focused; }
  hasTerminalRail(): boolean { return this.routeGrants(this.documentHostAreaPath() || this.entryPathname).includes('terminalKeyRail'); }

  private isTerminalRailRoute(path: string): boolean {
    return !this.overlayNavigation && BridgeHost.routeMatches('/h/[hostId]/session/[worktreeId]', path);
  }

  private reportRailClaim(): void {
    this.railClaimSink?.(this.client && this.isTerminalRailRoute(this.routePathname) ? this.railClaim : null);
  }

  private canDeliverRailKey(owner: string, key: string): boolean {
    let claim = this.railClaim;
    return !this.disposed && this.pushReady && this.pageReady && this.railFocused && this.client !== null &&
      claim !== null && claim.owner === owner && this.isTerminalRailRoute(this.routePathname) &&
      this.railKeys.includes(key) && terminalRailKeyEnabled(claim, key);
  }

  async sendTerminalRailKey(owner: string, key: string): Promise<boolean> {
    if (!this.canDeliverRailKey(owner, key)) { return false; }
    let frame = JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'terminalKey', inputOwner: owner, key: key });
    try {
      await this.controller.runJavaScript(`window.__orcaNativePush(${JSON.stringify(frame)})`);
      return this.canDeliverRailKey(owner, key);
    } catch (e) { return false; }
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
  private scheme: string = 'dark';
  private locationSink: ((pathname: string, params: Record<string, string>) => void) | null = null;
  private nativeNavigation: ((page: BridgeNativePage, replace: boolean) => void) | null = null;
  setLocationSink(sink: (pathname: string, params: Record<string, string>) => void): void { this.locationSink = sink; }
  setNativeNavigation(sink: (page: BridgeNativePage, replace: boolean) => void): void { this.nativeNavigation = sink; }
  setShellNavigation(sink: (pathname: string, params: Record<string, string>, replace: boolean) => void): void {
    this.shellNavigation = sink;
  }
  setWideLayout(wide: boolean): void { this.wideLayout = wide; }

  setStorage(store: PageStorageStore): void { this.storageStore = store; this.pageStorage = store.entries(); }
  setAutomationCatalog(read: () => DesktopAutomationCatalog | null): void { this.readAutomationCatalog = read; }
  refreshTerminalSettings(settings: Map<string, string>): void {
    let changed = false;
    TERMINAL_SETTINGS_STORAGE_KEYS.forEach((key: string): void => {
      const value = settings.get(key);
      if (value === this.pageStorage.get(key)) { return; }
      if (value === undefined) { this.pageStorage.delete(key); }
      else { this.pageStorage.set(key, value); }
      changed = true;
    });
    if (changed && this.navigationReady()) { this.sendInit(true); }
  }
  setRouteParams(params: Record<string, string>): void {
    this.routeParams = params; this.requestedOpen = params['open'] ?? '';
  }
  setColorScheme(scheme: string): void {
    if (this.scheme === scheme) { return; }
    this.scheme = scheme; if (this.pushReady && !this.disposed) { this.sendInit(); }
  }
  setNativeHandler(methods: string[], handler: (method: string, params: ESObject) => Promise<Object>): void {
    this.nativeMethods = methods; this.nativeHandler = handler;
  }
  setNavigation(back: (home: boolean) => void, paint: () => void): void { this.onBack = back; this.onPaint = paint; }
  setDesktopListBack(): void { this.desktopListBack = true; }
  setOverlayNavigation(navigate: (pathname: string, params: Record<string, string>) => void): void {
    this.overlayNavigation = navigate;
  }
  getRoute(): string { return this.routePathname; }
  getRouteParams(): Record<string, string> { return this.routeParams; }
  private navigationReady(): boolean { return this.pushReady && this.pageReady && !this.pageFaulted && !this.disposed; }

  private resetBack(): void { this.backEpoch++; this.backClaimed = false; this.backSendPending = false; }

  handleBack(onRefused: () => void = (): void => {}): boolean {
    if (!this.backClaimed || !this.navigationReady()) { return false; }
    if (this.backSendPending) { return true; }
    this.backSendPending = true;
    let epoch = this.backEpoch;
    let finish = (refused: boolean): void => {
      if (this.backEpoch !== epoch || this.disposed) { return; }
      this.backSendPending = false;
      if (refused) { this.backClaimed = false; onRefused(); }
    };
    try {
      let frame = JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'back' });
      this.controller.runJavaScript(`window.__orcaNativePush(${JSON.stringify(frame)}, false)`).then((value: string): void => {
        finish(value === 'unavailable' || value === '"unavailable"' || /^"?error:/.test(value));
      }, (): void => finish(true));
      return true;
    } catch (e) { this.resetBack(); return false; }
  }
  dispose(): void {
    if (this.disposed) { return; }
    this.resetBack();
    this.railClaimSink = null;
    let ids = Array.from(this.subscriptions);
    for (let i = 0; i < ids.length; i++) { this.releaseDesktopSubscription(ids[i]); }
    this.detachTransport();
    this.notifyStreamsEnded(); this.disposed = true;
    this.pushQueue = []; this.pendingIds.clear();
  }
  private logSink: ((line: string) => void) | null = null;

  constructor(client: SpikeRpcClient | null, controller: webview.WebviewController,
    manifest: BundleManifest, meta: HostMeta, routePathname: string, path: string = 'lan') {
    this.client = client;
    this.controller = controller;
    this.manifest = manifest;
    this.meta = meta;
    this.routePathname = routePathname;
    this.entryPathname = routePathname;
    this.sessionId = `sess-${meta.id}-${Date.now()}-${this.wirePrefix}`;
    this.connection = {
      state: client ? 'connected' : 'reconnecting', reconnectAttempt: 0, lastConnectedAt: client ? Date.now() : null,
      lastInboundAt: null, generation: client ? 1 : 0, activePath: path
    };
    if (client) { this.bindBinary(client); }
  }

  private bindBinary(client: SpikeRpcClient): void {
    this.unbindBinary = client.onBinaryFrames((bytes: Uint8Array): void => {
      if (this.disposed || this.client !== client) { return; }
      if (bytes[0] === 0x62) { this.onScreencastBinary(bytes); }
      else { this.onTerminalBinary(bytes); }
    });
  }

  private detachTransport(): void {
    const client = this.client;
    if (!client) { return; }
    this.client = null;
    this.railClaim = null; this.reportRailClaim();
    this.unbindBinary?.();
    this.unbindBinary = null;
    this.desktopPending.forEach((id: string): void => {
      this.pendingIds.delete(id);
      client.cancelById(this.wireId(id));
      this.sendError(id, 'Request delivery could not be confirmed', true);
    });
    this.desktopPending.clear();
    this.desktopSubs.forEach((record: DesktopSubscriptionRecord, id: string): void => {
      if (record.cancelled) { this.desktopSubs.delete(id); }
      else {
        client.cancelById(this.wireId(id));
        if (!RECONNECTABLE_STREAMS.includes(record.method)) { this.endDesktopSubscription(id); }
      }
    });
    this.streamIds.clear();
    this.snapshots.clear();
    this.streamWindows.clear();
  }

  suspendTransport(attempt: number, pendingPath?: string, relayHostReachability?: string): void {
    this.detachTransport();
    this.connection.pendingPath = pendingPath;
    this.connection.relayHostReachability = relayHostReachability;
    this.publishState('reconnecting', attempt);
  }

  attachTransport(client: SpikeRpcClient, path: string): void {
    if (this.disposed || this.client === client) { return; }
    this.detachTransport();
    this.client = client;
    this.bindBinary(client);
    this.connection.generation++;
    this.connection.lastConnectedAt = Date.now();
    this.connection.activePath = path;
    this.connection.pendingPath = undefined;
    this.connection.relayHostReachability = undefined;
    this.publishState('connected', 0);
    if (this.pageReady && this.hasTerminalRail()) { this.sendInit(); }
    this.desktopSubs.forEach((record: DesktopSubscriptionRecord, id: string): void => {
      if (!record.cancelled) { this.openDesktopSubscription(id, record, client, true); }
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

  /** A rest segment must be last and consume at least one segment. */
  static routeMatches(pattern: string, pathname: string): boolean {
    let pat = pattern.split('/');
    let act = pathname.split('/');
    let rest = pat.findIndex((segment: string): boolean => BridgeHost.isRestSegment(segment));
    if (rest >= 0 && rest !== pat.length - 1) { return false; }
    if (rest < 0 ? pat.length !== act.length : act.length <= rest) { return false; }
    for (let i = 0; i < pat.length; i++) {
      let seg = pat[i];
      if (i === rest) { return act.slice(i).every((part: string): boolean => part.length > 0); }
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

  private static isRestSegment(segment: string): boolean { return segment.startsWith('[...') && segment.endsWith(']'); }

  private servedRoutes(routes: BundleRoute[] = this.manifest.routes): BundleRoute[] {
    return routes.filter((route: BundleRoute): boolean => route.grants.every((grant: string): boolean => this.supportsGrant(grant)));
  }

  private static servesRoute(routes: BundleRoute[], pathname: string, wide: boolean): boolean {
    if (!routes.some((route: BundleRoute): boolean => BridgeHost.routeMatches(route.pathname, pathname))) { return false; }
    if (!wide) { return true; }
    let segments = pathname.split('/');
    if (segments[0] !== '' || segments[1] !== 'h' || !segments[2]) { return false; }
    let root = `/h/${segments[2]}`;
    return routes.some((route: BundleRoute): boolean => route.canOwnHostArea === true && BridgeHost.routeMatches(route.pathname, root));
  }

  static classifyRoute(pathname: string, manifest: BundleManifest, supports: (grant: string) => boolean,
    wide: boolean = false): string {
    if (!BridgeHost.servesRoute(manifest.routes, pathname, wide)) { return 'desktop'; }
    let implemented = manifest.routes.filter((route: BundleRoute): boolean => route.grants.every(supports));
    return BridgeHost.servesRoute(implemented, pathname, wide) ? '' : 'mobile';
  }

  routeBlock(pathname: string, wide: boolean = this.wideLayout): string {
    return BridgeHost.classifyRoute(pathname, this.manifest, (grant: string): boolean => this.supportsGrant(grant), wide);
  }

  ownsHostArea(pathname: string = this.routePathname): boolean {
    return pathname === `/h/${this.meta.id}` && this.hostAreaAvailable(this.wideLayout);
  }

  layoutChangesRouteView(wide: boolean): boolean {
    return wide !== this.wideLayout && (this.routeBlock(this.routePathname, wide) !== this.routeBlock(this.routePathname)
      || (this.desktopListBack ? this.hostAreaAvailable(true)
        : this.hostAreaAvailable(wide) !== this.hostAreaAvailable(this.wideLayout)));
  }

  private documentHostAreaPath(): string {
    let root = `/h/${this.meta.id}`;
    return (this.entryPathname === root || (this.desktopListBack && this.wideLayout))
      && this.hostAreaAvailable(this.wideLayout) ? root : '';
  }

  private hostAreaAvailable(wide: boolean): boolean {
    if (this.overlayNavigation) { return false; }
    return this.servedRoutes().some((route: BundleRoute): boolean => route.canOwnHostArea
      && (wide || route.canOwnHostAreaAcrossLayouts === true) && BridgeHost.routeMatches(route.pathname, `/h/${this.meta.id}`));
  }

  /**
   * Route grants (page-route-policy.ts routeViewOf): the active route's declared +
   * optional grants; a host-area owner gets the union of every served route plus
   * native.storage.read. Session pages navigate in-document, so the union is what
   * keeps their storage/navigate/verb grants alive on a single Web instance.
   */
  private supportsGrant(grant: string): boolean {
    if (grant === AUTOMATION_CATALOG_VERB) {
      return this.readAutomationCatalog !== null && this.entryPathname === `/h/${this.meta.id}/automations`;
    }
    if (grant === 'fault') { return this.faultSink !== null; }
    if (grant === 'externalLink') { return this.externalLink !== null; }
    if (grant === 'externalNavigation') { return this.externalNavigationEnabled; }
    if (grant === 'haptics') { return this.haptics !== null; }
    if (grant === 'terminalKeyRail') { return this.railClaimSink !== null && !this.overlayNavigation; }
    return BridgeHost.supportsCoreGrant(grant, this.nativeMethods);
  }

  static supportsCoreGrant(grant: string, nativeMethods: string[]): boolean {
    return ['navigate', 'storage', 'rpcEnvelope', 'screencastBinary', 'native.storage.read', 'native.store.rows'].includes(grant)
      || nativeMethods.includes(grant);
  }

  private routeGrants(pathname: string = this.routePathname): string[] {
    let grants = new Set<string>(['rpcEnvelope']);
    if (this.faultSink) { grants.add('fault'); }
    let hostArea = this.ownsHostArea(pathname);
    let entries = this.servedRoutes();
    let matching = hostArea ? entries : entries.filter((route: BundleRoute): boolean => BridgeHost.routeMatches(route.pathname, pathname));
    if (!hostArea && matching.length > 1) {
      let explicit = matching.find((route: BundleRoute): boolean =>
        !route.pathname.split('/').some((segment: string): boolean => BridgeHost.isRestSegment(segment)));
      matching = [explicit ?? matching[0]];
    }
    matching.forEach((route: BundleRoute): void => {
      this.grantsForEntry(route).forEach((grant: string): void => { grants.add(grant); });
    });
    if (hostArea) { grants.add('native.storage.read'); }
    return Array.from(grants);
  }

  private grantsForEntry(route: BundleRoute): string[] {
    return Array.from(new Set<string>([...route.grants, ...route.optionalGrants]
      .filter((grant: string): boolean => this.supportsGrant(grant))));
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

  sendAppInactive(): void {
    if (this.pageReady && this.pageReadsAppInactive && this.pushReady) {
      this.pushFrame(JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, type: 'appInactive' }));
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
      this.resetBack();
      this.pageReadsAppInactive = msg['appInactiveFrames'] === true;
      this.pageReady = true; this.railClaim = null; this.reportRailClaim();
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
      this.pageReady = false; this.resetBack();
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
    if (name === 'terminal-key-rail-claim') {
      if (!this.pageReady || !this.client || !this.hasTerminalRail() || typeof msg['claimed'] !== 'boolean') { return; }
      let claim = msg['claimed'] === true ? parseTerminalRailClaim(msg['inputOwner'], msg['toolbar']) : null;
      if (JSON.stringify(claim) !== JSON.stringify(this.railClaim)) {
        this.railClaim = claim; this.reportRailClaim();
      }
      return;
    }
    if (name === 'foreground' || name === 'liveness-probe') {
      this.livenessSink?.();
      return;
    }
    if (name === 'fault') {
      let error: ESObject = msg['error'];
      if (this.faultSink && this.navigationReady()
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
      if (!this.navigationReady()) { return; }
      let param: string = msg['param']; let value: string = msg['value'];
      if (param === 'open' && value === this.requestedOpen) { this.requestedOpen = ''; }
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
    if (name === 'navigate-back') {
      if (this.navigationReady() && !this.overlayNavigated && this.routeGrants().includes('navigate')) { this.onBack?.(false); }
      return;
    }
    if (name === 'back-claim') {
      if (this.navigationReady() && typeof msg['claimed'] === 'boolean') { this.backClaimed = msg['claimed']; }
      return;
    }
    if (name === 'painted') { if (this.navigationReady()) { this.onPaint?.(); } return; }
    if (name === 'navigate' || name === 'location') {
      this.handleRouteNotify(name === 'navigate', msg['href'], msg['replace'] === true);
      return;
    }
    this.log(`notify: ${name}`);
  }

  private handleRouteNotify(navigate: boolean, href: string, replace: boolean): void {
    if (!this.navigationReady() || this.overlayNavigated) { return; }
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
    if (pathname === '/terminal-settings') {
      if (navigate && queryAt < 0 && BridgeHost.routeMatches('/h/[hostId]/session/[worktreeId]', this.routePathname)) {
        this.nativeNavigation?.('terminal-settings', false);
      }
      return;
    }
    if (pathname !== hostPath && !pathname.startsWith(`${hostPath}/`)) { return; }
    if (!this.acceptsLocationPath(pathname)) { return; }
    if (this.desktopListBack && pathname === hostPath) {
      if (navigate) { this.onBack?.(false); }
      return;
    }
    if (this.overlayNavigation && pathname !== this.routePathname) {
      if (navigate) {
        this.overlayNavigated = true;
        this.overlayNavigation(pathname, params);
      }
      return;
    }
    let served = this.routeBlock(pathname) === '';
    if (navigate && pathname !== this.routePathname && (!served || !this.documentHostAreaPath())) {
      this.shellNavigation?.(pathname, params, replace);
      return;
    }
    if (!served) { return; }
    let previous = this.routePathname;
    this.routePathname = pathname;
    this.routeParams = params;
    if (previous !== pathname && this.hasTerminalRail()) {
      if (this.isTerminalRailRoute(previous)) { this.railClaim = null; }
      this.reportRailClaim();
      // A new session can claim before its location arrives. Ask it to reassert once the route is settled.
      if (this.pageReady && this.isTerminalRailRoute(previous) && this.isTerminalRailRoute(pathname)) { this.sendInit(); }
    }
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
        let key = decodeURIComponent((at < 0 ? pairs[i] : pairs[i].substring(0, at)).replace(/\+/g, ' '));
        let value = decodeURIComponent((at < 0 ? '' : pairs[i].substring(at + 1)).replace(/\+/g, ' '));
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
          route.pathname.split('/')[i] === '[worktreeId]' && BridgeHost.routeMatches(route.pathname, pathname));
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

  private pageRouteWorkspaceScope(pathname: string): string | null {
    let segments = pathname.split('/');
    if (segments.length !== 5 || segments[0] !== '' || segments[1] !== 'h' || segments[3] !== 'session') {
      return null;
    }
    try {
      let hostId = decodeURIComponent(segments[2]);
      let worktreeId = decodeURIComponent(segments[4]);
      if (hostId === this.meta.id && worktreeId.length > 0) {
        return `${encodeURIComponent(hostId)}:${encodeURIComponent(worktreeId)}`;
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  /** pageStorageKeysForRoute: exact keys + this host's pins key + workspace-scoped keys. */
  private isPageStorageKeyForRoute(key: string, pathname: string = this.routePathname): boolean {
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
    let scope = this.pageRouteWorkspaceScope(pathname);
    if (scope === null) {
      return false;
    }
    for (let i = 0; i < PAGE_WORKSPACE_STORAGE_KEY_PREFIXES.length; i++) {
      if (key === PAGE_WORKSPACE_STORAGE_KEY_PREFIXES[i] + scope) {
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
    for (let i = 0; i < PAGE_WORKSPACE_STORAGE_KEY_PREFIXES.length; i++) {
      let prefix = PAGE_WORKSPACE_STORAGE_KEY_PREFIXES[i];
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
    let hostArea = this.documentHostAreaPath() !== '';
    if (typeof key !== 'string'
      || key.length === 0
      || key.length > PAGE_STORAGE_MAX_KEY_CHARS
      || !(this.isPageStorageKeyForRoute(key) || (hostArea && this.isHostWorkspaceStorageKey(key)))
      || this.oversizeKeys.has(key)
      || (this.pageStorage.get(key)?.length ?? 0) > PAGE_STORAGE_MAX_VALUE_CHARS
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
      let subscription = this.desktopSubs.get(bridgeId);
      if (subscription) { subscription.params['viewport'] = { cols: intCols, rows: intRows }; }
      let streamId = this.streamIdForBridgeId(bridgeId);
      let client = this.client;
      if (streamId === null || !client) {
        this.log(`terminalViewport ${terminal} ${intCols}x${intRows}: no stream id yet for ${bridgeId}`);
        return;
      }
      // Claim then Resize (remote-runtime-terminal-multiplexer.claimViewport): new hosts
      // get precise ownership; hosts that ignore Claim still receive the Resize. seq 0.
      let payload = encodeViewportJson(intCols, intRows);
      let claimed = client.sendBinaryRaw(encodeTerminalFrame(OP_CLAIM_VIEWPORT, streamId, 0, payload));
      let resized = client.sendBinaryRaw(encodeTerminalFrame(OP_RESIZE, streamId, 0, payload));
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
    if (id.length === 0 || id.length > 128 || this.pendingIds.has(id) || this.subscriptions.has(id) || this.desktopSubs.has(id)) {
      this.sendError(id, 'request id unavailable'); return;
    }
    if (method.startsWith('native.')) { this.serveNativeRequest(msg, id, method, streaming); return; }
    let client = this.client;
    if (streaming) {
      if (!client && !RECONNECTABLE_STREAMS.includes(method)) { this.sendError(id, 'channel unavailable'); return; }
      if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        this.sendError(id, 'too-many-subscriptions');
        return;
      }
      if (method === 'browser.screencast' && msg['wantsBinary'] === true && this.routeGrants().includes('screencastBinary')) {
        if (this.binarySubscriptions.size > 0) { this.sendError(id, 'screencast already active'); return; }
        this.binarySubscriptions.add(id);
      }
      let params: ESObject = msg['params'];
      let record: DesktopSubscriptionRecord = { method: method, params: params, envelope: msg['envelope'], readyId: '', cancelled: false };
      this.desktopSubs.set(id, record);
      this.subscriptions.add(id);
      this.seq.set(id, 0);
      if (method === 'terminal.subscribe') {
        this.rememberTerminalSubscription(id, params);
      }
      if (client) { this.openDesktopSubscription(id, record, client, false); }
    } else {
      if (!client) { this.sendError(id, 'channel unavailable'); return; }
      let params: ESObject = this.substitutePageClientIdentity(msg['params'], client.deviceToken);
      let wireId = this.wireId(id);
      let wire = this.buildForwardWire(msg['envelope'], wireId, method, params, client);
      if (wire.length === 0) { this.sendError(id, 'invalid envelope'); return; }
      if (this.pendingIds.size >= MAX_PENDING_REQUESTS) { this.sendError(id, 'request limit'); return; }
      this.pendingIds.add(id); this.desktopPending.add(id);
      this.log(`→ ${method} (${id})`);
      let options: ESObject = msg['options'];
      let timeout: number = options && typeof options['timeoutMs'] === 'number' ? options['timeoutMs'] : 30000;
      client.requestRaw(wireId, wire, timeout).then((response: RpcResponse) => {
        if (this.client !== client || !this.desktopPending.delete(id) || !this.pendingIds.delete(id)) { return; }
        this.sendReply(id, response);
      }).catch(() => {
        if (this.client === client && this.desktopPending.delete(id) && this.pendingIds.delete(id)) { this.sendError(id, 'send-failed'); }
      });
    }
  }

  private openDesktopSubscription(id: string, record: DesktopSubscriptionRecord, client: SpikeRpcClient, replay: boolean): void {
    let params: ESObject = record.params === undefined ? undefined : JSON.parse(JSON.stringify(record.params));
    if (replay && record.method === 'terminal.subscribe' && params && typeof params === 'object' && !Array.isArray(params)) {
      params['resume'] = undefined;
    }
    let wireId = this.wireId(id);
    let screencast = record.method === 'browser.screencast';
    if (screencast && !client.claimScreencast(wireId)) {
      this.handleCancel({ id }); this.sendError(id, 'screencast already active'); return;
    }
    if (record.method === 'nativeChat.subscribe' && params && typeof params === 'object' && !Array.isArray(params)) {
      params['subscriptionId'] = wireId;
    }
    params = this.substitutePageClientIdentity(params, client.deviceToken);
    let wire = this.buildForwardWire(record.envelope, wireId, record.method, params, client);
    record.readyId = '';
    let window: StreamWindow = { outstanding: [], bytes: 0, backlog: [], backlogBytes: 0 };
    this.streamWindows.set(id, window);
    let sent = wire.length > 0 && client.subscribeWithId(wireId, wire, (responseJson: string): void => {
      if (!record.cancelled && (this.client !== client || this.desktopSubs.get(id) !== record)) { return; }
      if (!this.noteDesktopSubscription(id, record, client, responseJson)) { return; }
      this.rememberStreamId(id, responseJson);
      this.forwardEvent(id, responseJson);
    });
    if (!sent) {
      if (screencast) { client.releaseScreencast(wireId); }
      this.endDesktopSubscription(id);
    }
  }

  private endDesktopSubscription(id: string): void {
    this.desktopSubs.delete(id);
    this.handleCancel({ id });
    this.pushFrame(`{"v":1,"type":"end","id":${JSON.stringify(id)},"reason":"closed"}`);
  }

  private wireId(id: string): string { return `${this.wirePrefix}-r-${id}`; }

  private buildForwardWire(envelope: ESObject, id: string, method: string, params: ESObject, client: SpikeRpcClient): string {
    let wire: Record<string, Object> = {};
    if (envelope !== undefined) {
      if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) { return ''; }
      let keys = Object.keys(envelope);
      for (let i = 0; i < keys.length; i++) {
        let key = keys[i];
        if (['id', 'deviceToken', 'method', 'params', '__proto__', 'constructor', 'prototype'].includes(key)) { continue; }
        wire[key] = envelope[key];
      }
    }
    wire['id'] = id; wire['deviceToken'] = client.deviceToken; wire['method'] = method;
    if (params !== undefined && params !== null) { wire['params'] = params; }
    return JSON.stringify(wire);
  }

  /**
   * Swap the page's identity placeholder for the socket's authenticated token
   * (bridge-page-client-identity.ts): the desktop compares params.client.id with the
   * connection's principal (device.token) before granting input sessions/floors.
   */
  private substitutePageClientIdentity(paramsValue: ESObject, token: string): ESObject {
    if (paramsValue === undefined || paramsValue === null) {
      return paramsValue;
    }
    try {
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
    if (method === AUTOMATION_CATALOG_VERB) {
      if (this.routePathname !== `/h/${this.meta.id}/automations` || !this.routeGrants().includes(method)) {
        this.sendLocalNativeError(id, 'native_verb_ungranted', 'Automation catalog is not granted'); return;
      }
      let params: ESObject = msg['params'];
      if (!params || typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 0) {
        this.sendLocalNativeError(id, 'native_verb_params', 'Automation catalog does not take parameters'); return;
      }
      let catalog = this.client ? null : this.readAutomationCatalog?.();
      let result = catalog ? `{"readAt":${catalog.readAt},"result":${catalog.result}}` : 'null';
      this.sendReply(id, new RpcSuccess(id, result));
      return;
    }
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
      }).catch((error: Error): void => {
        if (!this.pendingIds.delete(id)) { return; }
        if (method === 'native.media.pick' && error instanceof NativeMediaTooLargeError) {
          this.sendLocalNativeError(id, 'native_media_too_large', error.message);
          return;
        }
        this.sendLocalNativeError(id, 'native_verb_failed', '设备操作未完成，请检查权限后重试');
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
    if (!this.documentHostAreaPath()) {
      this.sendLocalNativeError(id, 'native_verb_ungranted', 'the page was not granted native.storage.read');
      return;
    }
    let key = '';
    let paramsValue: ESObject = msg['params'];
    if (paramsValue !== null && typeof paramsValue === 'object' && !Array.isArray(paramsValue)
      && Object.keys(paramsValue).length === 1) {
      let params = paramsValue as Record<string, Object>;
      let keyValue: Object = params['key'];
      if (typeof keyValue === 'string') {
        key = keyValue;
      }
    }
    if (!this.isHostWorkspaceStorageKey(key)) {
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
    this.sendError(id, message, false, code);
  }

  private handleCancel(msg: ESObject): void {
    let cancelId: string = msg['id'];
    if (typeof cancelId !== 'string') { return; }
    this.pendingIds.delete(cancelId);
    this.desktopPending.delete(cancelId);
    if (!this.desktopSubs.has(cancelId)) { this.client?.cancelById(this.wireId(cancelId)); }
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

  private noteDesktopSubscription(id: string, record: DesktopSubscriptionRecord, client: SpikeRpcClient, json: string): boolean {
    try {
      let reply: ESObject = JSON.parse(json);
      let result: ESObject = reply['result'];
      if (reply['ok'] === false || result?.['type'] === 'end') {
        client.cancelById(this.wireId(id));
        if (record.method === 'browser.screencast') { client.releaseScreencast(this.wireId(id)); }
        if (this.desktopSubs.get(id) === record) {
          if (record.cancelled) { this.desktopSubs.delete(id); }
          else if (reply['ok'] === false) { this.endDesktopSubscription(id); }
          else {
            this.forwardEvent(id, json);
            this.endDesktopSubscription(id);
          }
        }
        return false;
      }
      if (result && typeof result['subscriptionId'] === 'string') { record.readyId = result['subscriptionId']; }
      if (record.cancelled && record.readyId) { this.closeDesktopSubscription(id, record, client); }
      return !record.cancelled && this.subscriptions.has(id);
    } catch (e) { return false; }
  }

  private releaseDesktopSubscription(id: string): void {
    let record = this.desktopSubs.get(id);
    if (!record) { return; }
    let transport = this.client;
    if (!transport) { this.desktopSubs.delete(id); return; }
    record.cancelled = true;
    this.closeDesktopSubscription(id, record, transport);
  }

  private closeDesktopSubscription(id: string, record: DesktopSubscriptionRecord, transport: SpikeRpcClient): void {
    let wireId = this.wireId(id);
    let params: Record<string, Object> = {};
    let method = '';
    let source: ESObject = record.params;
    if (record.method === 'terminal.subscribe' && source && typeof source['terminal'] === 'string') {
      let client: ESObject = source['client'];
      let clientId: string = client && typeof client['id'] === 'string' ? client['id'] : '';
      if (clientId === 'orca-page-client') { clientId = transport.deviceToken; }
      params['subscriptionId'] = clientId ? `${source['terminal']}:${clientId}` : source['terminal'];
      params['requestId'] = wireId;
      if (clientId) { let identity: Record<string, string> = { 'id': clientId }; params['client'] = identity; }
      method = 'terminal.unsubscribe';
    } else if (record.method === 'session.tabs.subscribeAll') {
      method = 'session.tabs.unsubscribeAll'; params['subscriptionId'] = wireId;
    } else if (record.method === 'session.tabs.subscribe' && source && typeof source['worktree'] === 'string') {
      method = 'session.tabs.unsubscribe'; params['worktree'] = source['worktree']; params['subscriptionId'] = wireId;
    } else if (record.method === 'agentSession.subscribe' && source && typeof source['sessionId'] === 'string') {
      method = 'agentSession.unsubscribe'; params['sessionId'] = source['sessionId']; params['subscriptionId'] = wireId;
    } else if (record.method === 'nativeChat.subscribe') {
      method = 'nativeChat.unsubscribe'; params['subscriptionId'] = wireId;
    } else if (SERVER_STREAM_RELEASE.has(record.method)) {
      if (record.method === 'browser.screencast') {
        if (this.desktopSubs.get(id) === record) { this.desktopSubs.delete(id); }
        if (!record.readyId) { transport.retirePendingScreencast(wireId); return; }
        transport.releaseScreencast(wireId);
      }
      if (!record.readyId) { return; }
      method = SERVER_STREAM_RELEASE.get(record.method) ?? '';
      params['subscriptionId'] = record.readyId;
    }
    if (this.desktopSubs.get(id) === record) { this.desktopSubs.delete(id); }
    transport.cancelById(wireId);
    if (!method) { return; }
    this.unsubscribeCounter++;
    let requestId = `${this.wirePrefix}-u-${this.unsubscribeCounter}`;
    let wire = this.buildForwardWire(record.envelope, requestId, method, params, transport);
    if (wire.length > 0) {
      transport.requestRaw(requestId, wire).catch((): void => {});
    }
  }

  private sendInit(refreshTerminalShortcuts: boolean = false): void {
    let hostAreaPath = this.documentHostAreaPath();
    let ownsHostArea = hostAreaPath !== '';
    let grants = this.routeGrants(hostAreaPath || this.routePathname);
    let pageRoutes: string[] = [];
    let pageRouteGrants: PageRouteGrant[] = [];
    let hostRoot = `/h/${this.meta.id}`;
    let rootUsesOwnDocument = !ownsHostArea && this.ownsHostArea(hostRoot);
    let entries = this.servedRoutes();
    for (let i = 0; i < entries.length; i++) {
      let entry = entries[i];
      let pattern = entry.pathname;
      let hostList = BridgeHost.routeMatches(pattern, hostRoot);
      if (this.desktopListBack && hostList) { continue; }
      if (!this.overlayNavigation || BridgeHost.routeMatches(pattern, this.routePathname)) {
        pageRoutes.push(pattern);
        if (!hostList || !rootUsesOwnDocument) {
          pageRouteGrants.push({ pathname: pattern, grants: this.grantsForEntry(entry) });
        }
      }
    }
    let rpcGrants: BridgeRpcGrants = {
      maxPendingRequests: MAX_PENDING_REQUESTS,
      maxSubscriptions: MAX_SUBSCRIPTIONS
    };
    let grantsValue: BridgeGrantsWire = {
      rpc: rpcGrants,
      native: grants
    };
    let hostParams: Record<string, string> = this.requestedOpen ? { 'open': this.requestedOpen } : {};
    // A wide standalone session owns its sidebar but starts at the session URL.
    let startsAtDesktop = ownsHostArea && this.entryPathname === hostRoot;
    let route: BridgeRouteWire = { pathname: startsAtDesktop ? hostRoot : this.routePathname,
      params: startsAtDesktop ? hostParams : this.routeParams };
    let hostValue: BridgeInitHostWire = {
      id: this.meta.id,
      name: this.meta.name,
      endpoint: this.meta.endpoint,
      lastConnected: this.meta.lastConnected,
      personalName: this.meta.personalName || undefined,
      lastKnownMachineName: this.meta.machineName || undefined,
      lastKnownHostPlatform: this.meta.hostPlatform
    };
    // pageStorageEntriesForInit: omit oversize values (they are unwritable), cap entries.
    let storage: Record<string, string> = {};
    let oversize: string[] = [];
    let count = 0;
    this.pageStorage.forEach((value: string, key: string) => {
      if (!this.pageReadsStorageKey(key) || !this.isPageStorageKeyForRoute(key, route.pathname)) {
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
      connection: this.connection,
      grants: grantsValue,
      route: route,
      pageRoutes: pageRoutes,
      pageRouteGrants: pageRouteGrants,
      colorScheme: this.scheme,
      uiLocale: this.locale,
      host: hostValue,
      storage: storage,
      storageOversize: oversize,
      refreshTerminalShortcuts: refreshTerminalShortcuts ? true : undefined,
      ownsHostArea: ownsHostArea,
      safeAreaInsets: this.safeAreaInsets,
      keyboardInset: this.keyboardInset,
      pageGeometry: this.pageGeometry,
      foldDivision: this.foldDivision,
      terminalKeyRail: this.railKeys
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
    if (response.wire.length > 0) {
      let payload: ESObject = JSON.parse(response.wire);
      payload['id'] = id;
      this.pushReply(id, JSON.stringify(payload));
      return;
    }
    let payloadJson: string;
    if (response instanceof RpcSuccess) {
      payloadJson = `{"id":${JSON.stringify(id)},"ok":true,"result":${response.result}}`;
    } else {
      let failure = response as Object as Record<string, string>;
      payloadJson = `{"id":${JSON.stringify(id)},"ok":false,"error":{"code":${JSON.stringify(failure['errorCode'])},"message":${JSON.stringify(failure['errorMessage'])}}}`;
    }
    this.pushReply(id, payloadJson);
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
        if (!this.client?.ownsScreencast(this.wireId(id)) || !this.desktopSubs.get(id)?.readyId) { return; }
        let event: Record<string, Object> = { 'v': 1, 'type': 'event', 'id': id, 'seq': this.nextSeq(id), 'binary': binary };
        this.pushStreamFrame(id, event['seq'] as number, JSON.stringify(event), true);
      });
    } catch (e) { }
  }

  private sendError(id: string, message: string, deliveryUnknown: boolean = false, code: string = ''): void {
    let coded = code ? `,"code":${JSON.stringify(code)}` : '';
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"error","id":${JSON.stringify(id)},"error":{"category":"Error","message":${JSON.stringify(message)},"isRpcDeliveryUnknown":${deliveryUnknown}${coded}}}`;
    this.pushFrame(frame);
  }

  /** Connection-state transitions surfaced to the page. */
  publishState(state: string, reconnectAttempt: number): void {
    this.connection.state = state;
    this.connection.reconnectAttempt = reconnectAttempt;
    let frame = `{"v":${BRIDGE_PROTOCOL_VERSION},"type":"state","connection":${JSON.stringify(this.connection)}}`;
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
