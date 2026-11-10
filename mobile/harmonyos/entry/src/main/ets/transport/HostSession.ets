import fflateModule from '../vendor/fflate-umd.js';
import { settleRuntimeCapabilities } from './RuntimeCapabilities';
import { common } from '@kit.AbilityKit';
import { SpikeRpcClient, RpcResponse, RpcSuccess } from './SpikeRpcClient';
import { HostMeta, updateRelayCredential, getRelayCredential, getDeviceToken, RelayCredentialFence } from '../storage/HostStore';
import { RelayCredential, RelayEndpoint, relayConnectUrl } from './RelayProtocol';
import { RelayDirectorRefusedError, resolveRelayEndpoint } from './RelayRouting';
import { rotateRelayCredential } from './RelayCredentialManager';
import { appendLog, LOG_LEVEL_INFO, LOG_LEVEL_SUCCESS, LOG_LEVEL_WARN, LOG_LEVEL_ERROR } from '../diagnostics/ConnectionLogStore';
import { directPath, RelayHostReachability } from '../diagnostics/ConnectionDiagnostics';

export type SessionPhase = 'idle' | 'connecting' | 'handshaking' | 'connected' | 'reconnecting' | 'stopped' | 'auth-failed';
type Listener = (phase: SessionPhase, detail: string) => void;
const STALE_DIAL_AGE_MS = 2000;

export class HostSession {
  private client: SpikeRpcClient | null = null;
  private meta: HostMeta;
  private token: string;
  private credential: RelayCredential | null;
  private context: common.Context | null;
  private stopped: boolean = true;
  private attempt: number = 0;
  private dialStartedAt: number = 0;
  private reconnectTimer: number = -1;
  private probeTimer: number = -1;
  private upgradeTimer: number = -1;
  private upgradeClient: SpikeRpcClient | null = null;
  private useRelayNext: boolean = false;
  private graceNext: boolean = false;
  private usingGrace: boolean = false;
  private directorNext: boolean = false;
  private activePath: string = 'lan';
  private pendingPath?: string;
  private phase: SessionPhase = 'idle';
  private connectedAt: number | null = null;
  private readonly localPath: string;
  private readonly relayReachability: RelayHostReachability | null;
  private rotating: boolean = false;
  private ownerSuperseded: boolean = false;
  private listeners: Listener[] = [];
  private logSink: ((line: string) => void) | null = null;

  constructor(meta: HostMeta, token: string, credential?: RelayCredential, context?: common.Context) {
    this.meta = meta; this.token = token; this.credential = credential ?? null; this.context = context ?? null;
    this.localPath = directPath(meta.endpoint);
    this.relayReachability = meta.relay ? new RelayHostReachability() : null;
  }
  setLogSink(sink: (line: string) => void): void { this.logSink = sink; }
  addListener(listener: Listener): () => void {
    this.listeners.push(listener);
    return (): void => { this.listeners = this.listeners.filter((held: Listener): boolean => held !== listener); };
  }
  getClient(): SpikeRpcClient | null { return this.client; }
  getActivePath(): string { return this.activePath; }
  getPendingPath(): string | undefined { return this.pendingPath; }
  getPhase(): SessionPhase { return this.phase; }
  getConnectedAt(): number | null { return this.connectedAt; }
  getReconnectAttempt(): number { return this.attempt; }
  getRelayHostReachability(): string { return this.relayReachability?.current() ?? 'connecting'; }
  private publish(phase: SessionPhase, detail: string): void {
    this.phase = phase;
    this.listeners.slice().forEach((listener: Listener): void => listener(phase, detail));
  }
  private log(line: string): void { if (this.logSink) { this.logSink(line); } }
  private record(level: string, message: string, code?: string, path?: string, closeCode?: number): void {
    let context = this.context;
    if (context) { appendLog(context, level, message, '', this.meta.id, code, path, closeCode).catch(() => {}); }
  }
  start(): void {
    if (!this.stopped) { return; }
    this.stopped = false;
    this.record(LOG_LEVEL_INFO, '正在连接桌面', 'client-session-started');
    this.dial();
  }
  stop(): void {
    this.stopped = true; this.pendingPath = undefined; this.clearTimers();
    let old = this.client; this.client = null;
    if (old) { old.close(); }
    let upgrade = this.upgradeClient; this.upgradeClient = null;
    if (upgrade) { upgrade.close(); }
    this.publish('stopped', '已断开');
  }
  revive(networkChanged: boolean = false): void {
    if (this.stopped) { return; }
    if (this.reconnectTimer >= 0) { this.dial(); return; }
    let client = this.client;
    if (!client) { return; }
    if (this.phase === 'connected') {
      this.checkHealth(client);
      if (networkChanged && this.activePath === 'relay' && !this.upgradeClient) { this.scheduleDirectUpgrade(client, 0); }
    } else if (networkChanged && this.pendingPath && Date.now() - this.dialStartedAt >= STALE_DIAL_AGE_MS) {
      this.useRelayNext = this.pendingPath === 'relay';
      this.graceNext = this.graceNext || this.usingGrace;
      this.client = null; client.close();
      this.dial();
    }
  }
  private clearTimers(): void {
    if (this.reconnectTimer >= 0) { clearTimeout(this.reconnectTimer); this.reconnectTimer = -1; }
    if (this.probeTimer >= 0) { clearTimeout(this.probeTimer); this.probeTimer = -1; }
    if (this.upgradeTimer >= 0) { clearTimeout(this.upgradeTimer); this.upgradeTimer = -1; }
  }
  private dial(): void {
    if (this.stopped) { return; }
    this.clearTimers();
    this.usingGrace = false;
    let useRelay = this.useRelayNext && this.meta.relay !== undefined && this.credential !== null;
    this.useRelayNext = false; this.pendingPath = useRelay ? 'relay' : this.localPath;
    this.dialStartedAt = Date.now();
    let client = new SpikeRpcClient(useRelay ? 30000 : 10000); this.client = client;
    client.setFflate(fflateModule); client.setLogSink((line: string): void => this.log(line));
    client.onSocketClosed((): void => this.retry(client));
    this.publish(this.attempt === 0 ? 'connecting' : 'reconnecting', useRelay ? '正在通过 Relay 连接' : '正在连接');
    this.connectAttempt(client, useRelay).then((): void => {
      if (this.stopped || this.client !== client) { client.close(); return; }
      this.markConnected(useRelay);
      this.probeLater(client);
      if (useRelay) { this.scheduleDirectUpgrade(client); }
      this.bookkeep(client).catch((): void => this.log('Relay 凭证更新暂未完成，将在下次认证后核对'));
    }).catch((error: Error): void => this.retry(client, false, error));
  }
  private markConnected(relay: boolean): void {
    this.attempt = 0; this.activePath = relay ? 'relay' : this.localPath; this.directorNext = false;
    this.relayReachability?.clear();
    this.pendingPath = undefined; this.connectedAt = Date.now();
    this.record(LOG_LEVEL_SUCCESS, '已连接', relay ? 'relay-connected' : 'direct-connected', this.activePath);
    this.publish('connected', this.meta.name);
  }

  private relayFence(credential: RelayCredential): RelayCredentialFence {
    let fence: RelayCredentialFence = { deviceToken: this.token, hash: credential.hash, version: credential.version, pendingReqId: credential.pendingReqId };
    return fence;
  }
  private async connectAttempt(client: SpikeRpcClient, useRelay: boolean): Promise<void> {
    let onHandshakeStarted = (): void => {
      if (!this.stopped && this.client === client) { this.publish('handshaking', ''); }
    };
    if (this.context && this.meta.relay) {
      let owner = await getDeviceToken(this.context, this.meta.id);
      if (owner !== this.token) { this.ownerSuperseded = true; throw new Error('Connection owner was superseded'); }
      let latest = await getRelayCredential(this.context, this.meta.id);
      if (this.stopped || this.client !== client) { throw new Error('Connection cancelled'); }
      this.credential = latest;
    }
    if (!useRelay || !this.meta.relay || !this.credential) {
      this.pendingPath = this.localPath;
      await client.connect(this.meta.endpoint, this.token, this.meta.publicKeyB64, 'v2', onHandshakeStarted);
      await settleRuntimeCapabilities(client); return;
    }
    let endpoint = this.meta.relay;
    let credential = this.credential;
    let grace = (this.graceNext || credential.expiresAt <= Date.now()) && credential.graceToken && credential.graceVersion && (credential.graceExpiresAt ?? 0) > Date.now();
    this.graceNext = false; this.usingGrace = Boolean(grace);
    let token = grace ? credential.graceToken! : credential.token;
    let version = grace ? credential.graceVersion! : credential.version;
    if (this.directorNext) {
      let next = await resolveRelayEndpoint(endpoint, token, this.meta.publicKeyB64);
      if (this.stopped || this.client !== client) { throw new Error('Connection cancelled'); }
      if (this.context) { await updateRelayCredential(this.context, this.meta.id, credential, next, this.relayFence(credential)); }
      if (this.stopped || this.client !== client) { throw new Error('Connection cancelled'); }
      this.meta.relay = next; endpoint = next;
    }
    if (this.stopped || this.client !== client) { throw new Error('Connection cancelled'); }
    client.configureRelay({ relayHostId: endpoint.relayHostId, credential: token, credentialKind: 'resume', credentialVersion: version });
    await client.connect(relayConnectUrl(endpoint.cellUrl, endpoint.relayHostId), this.token, this.meta.publicKeyB64, 'v2', onHandshakeStarted);
    await settleRuntimeCapabilities(client);
  }
  private retry(client: SpikeRpcClient, livenessFailed: boolean = false, error?: Error): void {
    if (this.stopped || this.client !== client || this.reconnectTimer >= 0) { return; }
    let wasConnected = this.phase === 'connected';
    let path = wasConnected ? this.activePath : this.pendingPath ?? this.localPath;
    let wasRelay = path === 'relay';
    let usedDirector = wasRelay && this.directorNext;
    if (usedDirector) { this.directorNext = false; }
    let code = wasRelay && error && error instanceof RelayDirectorRefusedError ? 4401 : client.getRelayCloseCode();
    this.clearTimers(); this.client = null; client.close();
    if (this.upgradeClient) { this.upgradeClient.close(); this.upgradeClient = null; }
    if (client.authenticationRejected() || this.ownerSuperseded) {
      this.pendingPath = undefined;
      this.record(LOG_LEVEL_ERROR, '凭证已失效，请重新配对', 'authentication-rejected', path);
      this.stopped = true; this.publish('auth-failed', '凭证已失效，请重新配对'); return;
    }
    if (wasRelay) { this.relayReachability?.record(code, client.getRelayCloseReason()); }
    let failure = livenessFailed ? 'liveness-timeout'
      : path === 'relay' ? (wasConnected ? 'relay-session-failed' : 'relay-dial-failed')
      : client.getDeadlineFailure() || 'socket-closed';
    this.record(LOG_LEVEL_WARN, '连接中断，正在重试', failure, path, path === 'relay' ? code : undefined);
    this.attempt++;
    let relay = this.meta.relay;
    let canRelay = relay && this.credential && (this.credential.expiresAt > Date.now() || (this.credential.graceExpiresAt ?? 0) > Date.now());
    let delay = Math.min(10000, 1000 * Math.pow(2, Math.min(this.attempt - 1, 4)));
    if (!wasRelay && canRelay) { this.useRelayNext = true; delay = 0; }
    else if (wasRelay && canRelay && code === 4401 && this.credential!.graceToken && (this.credential!.graceExpiresAt ?? 0) > Date.now() && !this.usingGrace) {
      this.useRelayNext = true; this.graceNext = true; delay = 1000;
    } else if (wasRelay && canRelay && !usedDirector && [0, 1006, 4409, 4503].includes(code)) {
      this.useRelayNext = true; this.directorNext = true;
    }
    this.pendingPath = this.useRelayNext ? 'relay' : this.localPath;
    this.log('连接中断，正在重试');
    this.publish('reconnecting', delay === 0 ? '正在切换到 Relay' : `${Math.ceil(delay / 1000)} 秒后重试`);
    this.reconnectTimer = setTimeout((): void => { this.reconnectTimer = -1; this.dial(); }, delay);
  }
  private async bookkeep(client: SpikeRpcClient): Promise<void> {
    if (!this.context || !this.credential || !this.meta.relay || this.rotating) { return; }
    this.rotating = true;
    try {
      let confirmation = client.getResumeConfirmation();
      if (confirmation && confirmation['acceptedAs'] === 'current' && confirmation['renewed'] === true
        && confirmation['currentVersion'] === this.credential.version && typeof confirmation['resumeExpiresAt'] === 'number') {
        this.credential.expiresAt = confirmation['resumeExpiresAt'];
        await updateRelayCredential(this.context, this.meta.id, this.credential, undefined, this.relayFence(this.credential));
      }
      if (this.stopped || this.client !== client) { return; }
      if (this.credential.pendingToken || this.credential.expiresAt - Date.now() <= 7 * 86400000) {
        let rotated = await rotateRelayCredential(this.context, this.meta, this.credential, client);
        if (!this.stopped && this.client === client) { this.credential = rotated.credential; this.meta.relay = rotated.endpoint; }
      }
    } finally {
      try {
        if (this.context && !this.stopped && await getDeviceToken(this.context, this.meta.id) === this.token) {
          let latest = await getRelayCredential(this.context, this.meta.id);
          if (latest && (!this.credential || latest.version >= this.credential.version)) { this.credential = latest; }
        }
      } catch (e) { }
      this.rotating = false;
    }
  }
  private probeLater(client: SpikeRpcClient): void {
    if (this.probeTimer >= 0) { clearTimeout(this.probeTimer); }
    this.probeTimer = setTimeout((): void => {
      this.probeTimer = -1;
      this.checkHealth(client);
    }, 20000);
  }
  private healthClient: SpikeRpcClient | null = null;
  private checkHealth(client: SpikeRpcClient): void {
    if (this.stopped || this.client !== client || this.healthClient === client) { return; }
    this.healthClient = client;
    client.request('status.get', null, 5000).then((response: RpcResponse): void => {
      if (this.stopped || this.client !== client) { return; }
      if (response instanceof RpcSuccess) {
        this.probeLater(client); this.bookkeep(client).catch((): void => {});
      } else { this.retry(client, true); }
    }).catch((): void => this.retry(client, true)).finally((): void => {
      if (this.healthClient === client) { this.healthClient = null; }
    });
  }
  private scheduleDirectUpgrade(relay: SpikeRpcClient, delay: number = 30000): void {
    if (this.upgradeTimer >= 0) { clearTimeout(this.upgradeTimer); }
    this.upgradeTimer = setTimeout((): void => {
      this.upgradeTimer = -1;
      if (this.stopped || this.client !== relay) { return; }
      let candidate = new SpikeRpcClient(5000); this.upgradeClient = candidate;
      candidate.setFflate(fflateModule); candidate.setLogSink((line: string): void => this.log(line));
      candidate.connect(this.meta.endpoint, this.token, this.meta.publicKeyB64, 'v2').then(async (): Promise<void> => {
        await settleRuntimeCapabilities(candidate);
        if (this.stopped || this.client !== relay || this.upgradeClient !== candidate) { candidate.close(); return; }
        this.clearTimers(); this.upgradeClient = null; this.client = candidate;
        candidate.onSocketClosed((): void => this.retry(candidate));
        this.markConnected(false); relay.close(); this.probeLater(candidate);
      }).catch((): void => {
        candidate.close();
        if (this.upgradeClient !== candidate) { return; }
        this.upgradeClient = null;
        if (!this.stopped && this.client === relay) { this.scheduleDirectUpgrade(relay); }
      });
    }, delay);
  }
}
