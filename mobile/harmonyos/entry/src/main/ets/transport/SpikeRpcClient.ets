import { RelayConnectionOptions, RelayMove, isRelayOrigin } from './RelayProtocol';
import { webSocket } from '@kit.NetworkKit';
import { util as textDecoderUtil } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { E2eeV2ClientSession, LegacyE2eeChannel, buildV2TokenAuthJson } from './E2eeV2Session';

const RELAY_ERROR_CLOSE_GRACE_MS = 250;

/**
 * Minimal direct-connection RPC client for Spike B: WebSocket + E2EE v2 handshake +
 * authenticated JSON RPC requests. Mirrors the wire behavior of upstream
 * mobile/src/transport/direct-rpc-client.ts without reconnection/liveness machinery.
 */

export class RpcSuccess {
  readonly wire: string;
  readonly id: string;
  readonly result: string; // raw JSON text of the result value

  constructor(id: string, result: string, wire: string = '') {
    this.wire = wire;
    this.id = id;
    this.result = result;
  }

  isOk(): boolean {
    return true;
  }
}

export class RpcFailure {
  readonly wire: string;
  readonly id: string;
  readonly errorCode: string;
  readonly errorMessage: string;

  constructor(id: string, errorCode: string, errorMessage: string, wire: string = '') {
    this.wire = wire;
    this.id = id;
    this.errorCode = errorCode;
    this.errorMessage = errorMessage;
  }

  isOk(): boolean {
    return false;
  }
}

export type RpcResponse = RpcSuccess | RpcFailure;

interface PendingRequest {
  resolve: (response: RpcResponse) => void;
  timer: number;
}

interface RetiredScreencast {
  id: string;
  onEvent: (responseJson: string) => void;
}

type ChannelState = 'awaiting-relay' | 'idle' | 'connecting' | 'awaiting-ready' | 'awaiting-authenticated' | 'ready' | 'closed';

export class SpikeRpcClient {
  private ws: webSocket.WebSocket = webSocket.createWebSocket();
  private session: E2eeV2ClientSession | null = null;
  private legacy: LegacyE2eeChannel | null = null;
  private framing: string = 'v2';
  private state: ChannelState = 'idle';
  private requestCounter = 0;
  private connectTimer: number = -1;
  private rejectConnect: ((error: Error) => void) | null = null;
  private closedNotified: boolean = false;
  private relayOptions: RelayConnectionOptions | null = null;
  private relayMove: RelayMove | null = null;
  private resumeConfirmation: Record<string, Object> | null = null;
  private relayAcceptedVersion: number = 0;
  private relayCloseCode: number = 0;
  private relayCloseReason: string = '';
  private relayCloseTimer: number = -1;
  private relayRefused: boolean = false;
  private authRejected: boolean = false;
  private deadlineFailure: string = '';
  getDeadlineFailure(): string { return this.deadlineFailure; }
  authenticationRejected(): boolean { return this.authRejected; }
  configureRelay(options: RelayConnectionOptions): void {
    if (!/^[A-Za-z0-9_-]{16}$/.test(options.relayHostId) || !/^[A-Za-z0-9_-]{43}$/.test(options.credential)
      || !['invite', 'resume'].includes(options.credentialKind)
      || (options.pairingRecovery && options.credentialKind !== 'resume')) { throw new Error('Invalid relay credentials'); }
    this.relayOptions = options;
  }
  getRelayMove(): RelayMove | null { return this.relayMove; }
  getRelayCloseCode(): number { return this.relayCloseCode; }
  getRelayCloseReason(): string { return this.relayCloseReason; }
  relayCredentialRejected(): boolean { return this.relayRefused && this.relayCloseCode === 4401; }
  getRelayAcceptedVersion(): number { return this.relayAcceptedVersion; }
  getResumeConfirmation(): Record<string, Object> | null { return this.resumeConfirmation; }
  isRelay(): boolean { return this.relayOptions !== null; }
  private handshakeMs: number;
  private requestMs: number;

  constructor(handshakeMs: number = 10000, requestMs: number = 15000) {
    this.handshakeMs = handshakeMs;
    this.requestMs = requestMs;
  }

  private finishConnect(): void {
    if (this.connectTimer >= 0) { clearTimeout(this.connectTimer); this.connectTimer = -1; }
    this.rejectConnect = null;
  }

  private terminate(reason: string): void {
    if (this.state === 'closed' && this.closedNotified) { return; }
    if (this.relayCloseTimer >= 0) { clearTimeout(this.relayCloseTimer); this.relayCloseTimer = -1; }
    let reject = this.rejectConnect;
    this.finishConnect();
    this.state = 'closed';
    if (reject) { reject(new Error(reason)); }
    this.rejectAllPending(reason);
    this.streams.clear();
    this.screencastOwner = '';
    this.retiredScreencast = null;
    if (!this.closedNotified) {
      this.closedNotified = true;
      for (let i = 0; i < this.closeListeners.length; i++) { this.closeListeners[i](); }
    }
    try { this.ws.close().catch(() => {}); } catch (e) { }
  }

  private waitForRelayClose(): void {
    if (this.state === 'closed' || this.relayCloseTimer >= 0) { return; }
    this.relayCloseTimer = setTimeout((): void => {
      if (!this.relayRefused) { this.relayCloseCode = 1006; }
      this.terminate('Relay connection closed');
    }, RELAY_ERROR_CLOSE_GRACE_MS);
  }
  private pending: Map<string, PendingRequest> = new Map();
  private streams: Map<string, (responseJson: string) => void> = new Map();
  private closeListeners: (() => void)[] = [];
  private binaryListeners: ((bytes: Uint8Array) => void)[] = [];
  private screencastOwner: string = '';
  private retiredScreencast: RetiredScreencast | null = null;

  claimScreencast(id: string): boolean {
    if (this.screencastOwner) { return false; }
    this.screencastOwner = id; return true;
  }
  ownsScreencast(id: string): boolean { return this.screencastOwner === id; }
  releaseScreencast(id: string): void { if (this.ownsScreencast(id)) { this.screencastOwner = ''; } }

  retirePendingScreencast(id: string): void {
    if (!this.ownsScreencast(id)) { return; }
    this.releaseScreencast(id);
    let onEvent = this.streams.get(id);
    if (!onEvent) { return; }
    this.streams.delete(id);
    this.retiredScreencast = { id: id, onEvent: onEvent };
  }

  onBinaryFrames(listener: (bytes: Uint8Array) => void): () => void {
    this.binaryListeners.push(listener);
    return (): void => {
      let index = this.binaryListeners.indexOf(listener);
      if (index >= 0) { this.binaryListeners.splice(index, 1); }
    };
  }
  private logSink: ((line: string) => void) | null = null;
  private currentDeviceToken: string = '';

  get deviceToken(): string {
    return this.currentDeviceToken;
  }

  onSocketClosed(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  setLogSink(sink: (line: string) => void): void {
    this.logSink = sink;
  }

  private log(line: string): void {
    if (this.logSink) {
      this.logSink(line);
    }
  }

  /** Connects and runs the E2EE handshake (framing 'v2' or 'legacy'); resolves once authenticated. */
  connect(endpoint: string, deviceToken: string, serverPublicKeyB64: string, framing: string,
    onHandshakeStarted?: () => void): Promise<void> {
    if (this.relayOptions?.pairingRecovery && framing !== 'v2') {
      return Promise.reject(new Error('Relay pairing recovery requires E2EE v2'));
    }
    this.currentDeviceToken = deviceToken;
    this.framing = framing;
    return new Promise<void>((resolve, reject) => {
      this.state = 'connecting';
      this.closedNotified = false;
      this.relayAcceptedVersion = 0;
      this.relayCloseCode = 0;
      this.relayCloseReason = '';
      this.relayRefused = false;
      this.rejectConnect = reject;
      this.connectTimer = setTimeout((): void => {
        this.deadlineFailure = this.state === 'connecting' ? 'connect-timeout' : 'handshake-timeout';
        this.terminate('连接超时，请检查桌面和网络');
      }, this.handshakeMs);
      let connected = (): void => { this.finishConnect(); resolve(); };
      let failed = (error: Error): void => this.terminate(error.message);
      this.log(this.relayOptions ? '正在建立 Relay 加密连接' : '正在建立直连加密连接');
      this.ws.on('open', (_err: BusinessError, _value: Object) => {
        try {
          if (this.state !== 'connecting') { return; }
          if (this.relayOptions) {
            this.state = 'awaiting-relay';
            let auth: Record<string, Object> = { 'type': 'relay-auth', 'v': 1, 'mode': 'connect', 'credential': this.relayOptions.credential };
            this.sendRaw(JSON.stringify(auth)); return;
          }
          this.beginHandshake(serverPublicKeyB64, onHandshakeStarted);
        } catch (e) {
          failed(e as Error);
        }
      });
      this.ws.on('message', (_err: BusinessError, value: string | ArrayBuffer) => {
        try {
          if (this.relayRefused) { return; }
          if (this.state === 'awaiting-relay') { this.acceptRelayHello(value, serverPublicKeyB64, onHandshakeStarted); return; }
          if (this.state !== 'closed') { this.handleMessage(value, deviceToken, connected, failed); }
        } catch (e) {
          this.log('连接协议验证失败');
          failed(new Error('Connection protocol validation failed'));
        }
      });
      this.ws.on('close', (_err: BusinessError, value: webSocket.CloseResult) => {
        if (this.state === 'closed') { return; }
        if (!this.relayRefused) { this.relayCloseCode = value.code || 1006; }
        if (this.relayOptions) { this.relayCloseReason = value.reason ?? ''; }
        if (this.state === 'ready' && value.code === 4001 && value.reason === 'Unauthorized') {
          this.authRejected = true;
        }
        this.log('连接已关闭');
        this.terminate('socket closed');
      });
      this.ws.on('error', (_err: BusinessError) => {
        this.log('网络连接失败');
        if (this.relayOptions) { this.waitForRelayClose(); }
        else { this.terminate('socket error'); }
      });
      try { this.ws.connect(endpoint, (err: BusinessError) => {
        if (err) {
          this.log(`connect failed: ${err.message}`);
          if (this.relayOptions) { this.waitForRelayClose(); }
          else { failed(err as Error); }
        }
      }); } catch (e) { failed(e as Error); }
    });
  }

  private beginHandshake(serverPublicKeyB64: string, onHandshakeStarted?: () => void): void {
    this.state = 'awaiting-ready';
    let hello: string;
    if (this.framing === 'legacy') {
      this.legacy = new LegacyE2eeChannel(serverPublicKeyB64); hello = this.legacy.helloJson;
    } else {
      this.session = new E2eeV2ClientSession(this.relayOptions ? 'relay' : 'direct', this.relayOptions ? this.relayOptions.relayHostId : '');
      this.session.setPinnedKey(serverPublicKeyB64); hello = this.session.helloJson;
    }
    onHandshakeStarted?.();
    if (this.state === 'awaiting-ready') { this.sendRaw(hello); }
  }
  private acceptRelayHello(value: string | ArrayBuffer, publicKeyB64: string, onHandshakeStarted?: () => void): void {
    if (typeof value !== 'string' || value.length > 16384 || !this.relayOptions) { throw new Error('Invalid relay hello'); }
    let hello: ESObject = JSON.parse(value);
    if (hello && hello['type'] === 'relay-moved' && hello['v'] === 1 && isRelayOrigin(hello['cellUrl'])
      && Number.isSafeInteger(hello['assignmentEpoch']) && hello['assignmentEpoch'] >= 0) {
      this.relayMove = { cellUrl: hello['cellUrl'], assignmentEpoch: hello['assignmentEpoch'] };
      this.terminate('Relay assignment moved'); return;
    }
    if (!hello || hello['type'] !== 'relay-hello' || typeof hello['ok'] !== 'boolean') { throw new Error('Invalid relay hello'); }
    if (hello['ok'] === false) {
      let code: number = hello['code'];
      if (Object.keys(hello).length !== 3 || !Number.isSafeInteger(code) || code < 4000 || code > 4999) {
        throw new Error('Invalid relay refusal');
      }
      this.relayCloseCode = code;
      this.relayRefused = true;
      this.waitForRelayClose(); return;
    }
    if (hello['credentialKind'] !== this.relayOptions.credentialKind || !Number.isSafeInteger(hello['leaseExpiresAt'])
      || hello['leaseExpiresAt'] <= Date.now()) { throw new Error('Relay credential kind or lease mismatch'); }
    if (hello['credentialKind'] === 'resume') {
      let acceptedVersion: number = hello['acceptedCredentialVersion'];
      let expectedVersion = this.relayOptions.credentialVersion;
      let pendingVersion = this.relayOptions.pairingRecovery && expectedVersion === undefined;
      if (!Number.isSafeInteger(acceptedVersion) || acceptedVersion <= 0 || (!pendingVersion && acceptedVersion !== expectedVersion)) {
        throw new Error('Relay credential version mismatch');
      }
      this.relayAcceptedVersion = acceptedVersion;
    }
    this.beginHandshake(publicKeyB64, onHandshakeStarted);
  }
  private confirmResume(connected: () => void, failed: (error: Error) => void): void {
    let params: Record<string, string> = { 'resumeConfirmReqId': `confirm-${Date.now()}-${this.requestCounter++}` };
    this.request('pairing.getEndpoints', JSON.stringify(params)).then((reply: RpcResponse): void => {
      if (!(reply instanceof RpcSuccess) || !this.relayOptions) { failed(new Error('Relay resume confirmation failed')); return; }
      try {
        let result: ESObject = JSON.parse(reply.result);
        let confirmation: ESObject = result['resumeConfirmation'];
        if (!confirmation || result['relay']['relayHostId'] !== this.relayOptions.relayHostId
          || confirmation['v'] !== 1 || confirmation['reqId'] !== params.resumeConfirmReqId
          || !['current', 'grace'].includes(confirmation['acceptedAs'])
          || (confirmation['acceptedAs'] === 'current' && confirmation['currentVersion'] !== this.relayOptions.credentialVersion)
          || (confirmation['acceptedAs'] === 'grace' && (!Number.isSafeInteger(confirmation['graceExpiresAt']) || confirmation['graceExpiresAt'] <= Date.now()))
          || !Number.isSafeInteger(confirmation['resumeExpiresAt'])) { throw new Error('Invalid relay resume confirmation'); }
        this.resumeConfirmation = confirmation; connected();
      } catch (e) { failed(new Error('Invalid relay resume confirmation')); }
    }).catch((): void => failed(new Error('Relay resume confirmation failed')));
  }

  close(): void {
    this.terminate('connection cancelled');
  }

  getState(): string {
    return this.state;
  }

  private handleMessage(value: string | ArrayBuffer, deviceToken: string,
    resolveConnect: () => void, rejectConnect: (e: Error) => void): void {
    if (typeof value === 'string') {
      if (this.state === 'awaiting-ready') {
        this.acceptReady(value, deviceToken, resolveConnect, rejectConnect);
        return;
      }
      let plaintext = this.framing === 'legacy'
        ? (this.legacy ? this.legacy.openText(value) : null)
        : (this.session ? this.session.openText(value) : null);
      if (plaintext === null) {
        return;
      }
      if (this.state === 'awaiting-authenticated') {
        this.finishAuthentication(plaintext, resolveConnect, rejectConnect);
        return;
      }
      this.deliverRpcText(plaintext);
      return;
    }
    // Binary frames: E2EE open → compressed-frame unwrap → terminal listeners.
    this.handleBinary(new Uint8Array(value));
  }

  private handleBinary(bytes: Uint8Array): void {
    if (!this.session) {
      return;
    }
    let opened = this.session.openBinary(bytes);
    if (opened === null) {
      return;
    }
    // A compressed payload is already decrypted: never pass it through openBinary twice.
    if (opened.length >= 6 && opened[0] === 0x7a) {
      let kind = opened[1];
      let length = new DataView(opened.buffer, opened.byteOffset, opened.byteLength).getUint32(2, true);
      if ((kind !== 1 && kind !== 2) || length > 4 * 1024 * 1024) {
        this.terminate('invalid compressed frame'); return;
      }
      try {
        let mod: ESObject = this.fflate as ESObject;
        let output = new Uint8Array(length + 1);
        let inflated = mod['gunzipSync'](opened.subarray(6), { out: output }) as Uint8Array;
        if (inflated.length !== length) { throw new Error('compressed length mismatch'); }
        if (kind === 1) { this.handleTextFrame(this.utf8(inflated)); }
        else { this.deliverBinary(inflated); }
      } catch (e) { this.terminate('compressed frame rejected'); }
      return;
    }
    this.deliverBinary(opened);
  }

  private deliverBinary(bytes: Uint8Array): void {
    for (let i = 0; i < this.binaryListeners.length; i++) { this.binaryListeners[i](bytes); }
  }

  private handleTextFrame(plaintext: string): void {
    this.deliverRpcText(plaintext);
  }

  private utf8(bytes: Uint8Array): string {
    let decoder = textDecoderUtil.TextDecoder.create('utf-8');
    return decoder.decodeToString(bytes);
  }

  private fflate: Object | null = null;

  setFflate(module: Object): void {
    this.fflate = module;
  }

  private acceptReady(readyText: string, deviceToken: string,
    resolveConnect: () => void, rejectConnect: (e: Error) => void): void {
    let authFrame: string;
    if (this.framing === 'legacy') {
      if (!this.legacy || !this.legacy.acceptReady(readyText)) {
        rejectConnect(new Error('Invalid legacy e2ee_ready'));
        return;
      }
      let auth: Record<string, Object> = { 'type': 'e2ee_auth', 'deviceToken': deviceToken };
      authFrame = this.legacy.sealText(JSON.stringify(auth));
    } else {
      let parsed: Object | null = JSON.parse(readyText) as Object | null;
      if (!this.session) {
        rejectConnect(new Error('session missing'));
        return;
      }
      if (!this.session.acceptReady(parsed)) {
        rejectConnect(new Error('Invalid E2EE v2 ready (validation or pinned-key mismatch)'));
        return;
      }
      authFrame = this.session.sealText(buildV2TokenAuthJson(this.session.transcriptHashB64, deviceToken));
    }
    this.state = 'awaiting-authenticated';
    this.log('ready accepted — sending sealed token auth');
    this.sendRaw(authFrame);
  }

  private finishAuthentication(plaintext: string,
    resolveConnect: () => void, rejectConnect: (e: Error) => void): void {
    let parsed: Object | null = JSON.parse(plaintext) as Object | null;
    if (parsed === null || typeof parsed !== 'object') {
      rejectConnect(new Error('Invalid E2EE v2 authenticated response'));
      return;
    }
    let reply = parsed as Record<string, Object>;
    if (reply['type'] === 'e2ee_error') {
      this.authRejected = true;
      rejectConnect(new Error('E2EE authentication rejected'));
      return;
    }
    if (this.framing === 'legacy') {
      if (reply['type'] === 'e2ee_authenticated') {
        this.state = 'ready';
        this.log('authenticated (legacy) — channel ready');
        resolveConnect();
      } else {
        rejectConnect(new Error('Unexpected authentication reply'));
      }
      return;
    }
    let transcriptHashB64 = this.session ? this.session.transcriptHashB64 : '';
    let echoValue: Object = reply['transcriptHashB64'];
    let ok = reply['type'] === 'e2ee_authenticated'
      && reply['v'] === 2
      && typeof echoValue === 'string'
      && echoValue === transcriptHashB64;
    if (!ok) {
      rejectConnect(new Error('Unexpected authentication reply'));
      return;
    }
    this.state = 'ready';
    this.log('authenticated — channel ready');
    if (this.relayOptions && this.relayOptions.credentialKind === 'resume' && !this.relayOptions.pairingRecovery) {
      this.confirmResume(resolveConnect, rejectConnect);
    } else { resolveConnect(); }
  }

  private deliverRpcText(plaintext: string): void {
    let parsed: Object | null = JSON.parse(plaintext) as Object | null;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    let rec = parsed as Record<string, Object>;
    let idValue: Object = rec['id'];
    if (typeof idValue !== 'string') {
      return;
    }
    let id = idValue;
    let streamingValue: Object = rec['streaming'];
    let retired = this.retiredScreencast;
    let stream = this.streams.get(id) ?? (retired?.id === id ? retired.onEvent : undefined);
    if (streamingValue === true) {
      stream?.(plaintext);
      return;
    }
    if (stream && rec['ok'] === false) { this.cancelById(id); stream(plaintext); return; }
    let pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    let okValue: Object = rec['ok'];
    if (okValue === true) {
      pending.resolve(new RpcSuccess(id, JSON.stringify(rec['result']), plaintext));
    } else {
      let errorValue: Object = rec['error'];
      let errorCode = '';
      let errorMessage = plaintext;
      if (errorValue !== null && errorValue !== undefined && typeof errorValue === 'object') {
        let error = errorValue as Record<string, Object>;
        let codeValue: Object = error['code'];
        let messageValue: Object = error['message'];
        if (typeof codeValue === 'string') {
          errorCode = codeValue;
        }
        if (typeof messageValue === 'string') {
          errorMessage = messageValue;
        }
      }
      pending.resolve(new RpcFailure(id, errorCode, errorMessage, plaintext));
    }
  }

  /** Fire-and-forget send; @ohos.net.webSocket send() returns a Promise. */
  private sendRaw(frame: string): boolean {
    try {
      this.ws.send(frame).catch(() => this.terminate('ws send failed'));
      return true;
    } catch (e) {
      this.terminate('ws send failed'); return false;
    }
  }

  /**
   * Client→host binary lane (upstream MobileE2eeV2PhysicalChannel.sendBinary):
   * sealBinary(plaintext) sent as one raw WebSocket binary frame. No compression
   * wrapper — the 0x7a lane is desktop→mobile only.
   */
  sendBinaryRaw(bytes: Uint8Array): boolean {
    if (this.state !== 'ready' || !this.session) {
      return false;
    }
    try {
      let sealed = this.session.sealBinary(bytes);
      let buffer = new ArrayBuffer(sealed.byteLength);
      new Uint8Array(buffer).set(sealed);
      this.ws.send(buffer).catch(() => this.terminate('ws send failed'));
      return true;
    } catch (e) {
      return false;
    }
  }

  private rejectAllPending(reason: string): void {
    this.pending.forEach((pending: PendingRequest, id: string) => {
      clearTimeout(pending.timer);
      pending.resolve(new RpcFailure(id, 'closed', reason));
    });
    this.pending.clear();
  }

  /** Wire frame in upstream buildDirectRpcWireRequest key order (id, deviceToken, method, params). */
  buildWire(id: string, method: string, paramsJson: string | null, executionHost?: string): string {
    let obj: Record<string, Object> = {
      'id': id,
      'deviceToken': this.currentDeviceToken,
      'method': method
    };
    if (paramsJson !== null) { obj['params'] = JSON.parse(paramsJson) as Object; }
    if (executionHost) { obj['executionHost'] = executionHost; }
    return JSON.stringify(obj);
  }

  /** Bounded request lifecycle; no retry here because a mutation may already have executed. */
  requestRaw(id: string, wire: string, timeoutMs: number = this.requestMs): Promise<RpcResponse> {
    return new Promise<RpcResponse>((resolve) => {
      if (this.state !== 'ready' || (!this.session && !this.legacy)) {
        resolve(new RpcFailure(id, 'not-ready', 'channel not ready')); return;
      }
      if (this.pending.has(id) || this.streams.has(id) || this.pending.size >= 64) {
        resolve(new RpcFailure(id, 'request-limit', 'request id or capacity unavailable')); return;
      }
      let timer = setTimeout((): void => {
        this.pending.delete(id);
        resolve(new RpcFailure(id, 'timeout', 'request timed out; delivery may have occurred'));
      }, Math.max(1, Math.min(120000, timeoutMs)));
      this.pending.set(id, { resolve: resolve, timer: timer });
      try {
        let sealed = this.framing === 'legacy' ? this.legacy!.sealText(wire) : this.session!.sealText(wire);
        if (!this.sendRaw(sealed)) { throw new Error('ws send failed'); }
      } catch (e) {
        clearTimeout(timer); this.pending.delete(id);
        resolve(new RpcFailure(id, 'send-failed', 'ws send failed'));
      }
    });
  }

  request(method: string, params: string | null, timeoutMs: number = this.requestMs, executionHost?: string): Promise<RpcResponse> {
    this.requestCounter++;
    let id = `rpc-${this.requestCounter}-${Date.now()}`;
    try { return this.requestRaw(id, this.buildWire(id, method, params, executionHost), timeoutMs); }
    catch (e) { return Promise.resolve(new RpcFailure(id, 'invalid-params', 'invalid request params')); }
  }

  /** Stream subscription (Phase 2a): JSON events routed raw to the handler; no server-side unsubscribe. */
  subscribeWithId(id: string, wire: string, onEvent: (responseJson: string) => void): boolean {
    if (this.state !== 'ready' || !this.session) {
      return false;
    }
    if (this.streams.has(id) || this.pending.has(id) || this.streams.size >= 32) { return false; }
    this.streams.set(id, onEvent);
    if (!this.sendRaw(this.session.sealText(wire))) {
      this.streams.delete(id);
      return false;
    }
    // Desktop replaces the prior stream on this socket, including starts cancelled before ready.
    if (this.ownsScreencast(id)) { this.retiredScreencast = null; }
    return true;
  }

  cancelById(id: string): void {
    this.streams.delete(id);
    if (this.retiredScreencast?.id === id) { this.retiredScreencast = null; }
    let pending = this.pending.get(id);
    if (pending) { clearTimeout(pending.timer); this.pending.delete(id); pending.resolve(new RpcFailure(id, 'cancelled', 'request cancelled')); }
  }
}
