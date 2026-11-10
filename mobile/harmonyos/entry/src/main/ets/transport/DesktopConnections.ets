import { common } from '@kit.AbilityKit';
import { appendLog, LOG_LEVEL_INFO } from '../diagnostics/ConnectionLogStore';
import { DesktopNotifications } from '../notifications/DesktopNotifications';
import { getDeviceToken, getRelayCredential, HostMeta, listHosts } from '../storage/HostStore';
import { HostSession, SessionPhase } from './HostSession';
import { RelayCredential } from './RelayProtocol';
import { SpikeRpcClient } from './SpikeRpcClient';

type ProfileChange = 'name' | 'endpoint' | 'paired';
type RevivalReason = 'app-resume' | 'network-change';
type LeaseDemand = 'automatic' | 'explicit';

type DesktopListener = (phase: SessionPhase, detail: string) => void;
export type DesktopCredentialStatus = 'ready' | 'missing' | 'temporarily-unavailable';
export interface DesktopAutomationCatalog { result: string; readAt: number; }

interface DesktopCredentials { token: string | null; relay: RelayCredential | null; }
export interface HomeDesktopConnection { host: HostMeta; connection: DesktopConnection; }

export interface DesktopConnectionLease {
  connection: DesktopConnection;
  release: (keepForNavigation?: boolean) => void;
}

const desktops = new Map<string, DesktopConnection>();
const idleTimers = new Map<string, number>();
const HOME_AUTO_CONNECT_LIMIT = 3;

function cancelIdle(hostId: string): void {
  let timer = idleTimers.get(hostId);
  if (timer !== undefined) { clearTimeout(timer); idleTimers.delete(hostId); }
}

function closeIdle(hostId: string, connection: DesktopConnection): void {
  cancelIdle(hostId);
  if (desktops.get(hostId) === connection && connection.closeIdle()) { desktops.delete(hostId); }
}

export function closeIdleDesktopConnections(): void {
  Array.from(idleTimers.keys()).forEach((id: string): void => {
    let connection = desktops.get(id);
    if (connection) { closeIdle(id, connection); }
  });
}

export function retainDesktopConnection(context: common.UIAbilityContext, hostId: string,
  demand?: LeaseDemand): DesktopConnectionLease {
  cancelIdle(hostId);
  let existing = desktops.get(hostId);
  let connection = existing ?? new DesktopConnection(context, hostId);
  if (!existing) { desktops.set(hostId, connection); }
  connection.retain(demand);
  let held = true;
  return { connection: connection, release: (keepForNavigation: boolean = false): void => {
    if (!held) { return; }
    held = false;
    if (!connection.release(demand) || desktops.get(hostId) !== connection) { return; }
    // A shell can pop before Home finishes reading a newly paired desktop.
    if (keepForNavigation) {
      cancelIdle(hostId);
      idleTimers.set(hostId, setTimeout((): void => closeIdle(hostId, connection), 2000));
    } else { closeIdle(hostId, connection); }
  } };
}

export function refreshDesktopConnection(hostId: string, change: ProfileChange): void {
  desktops.get(hostId)?.refresh(change);
}

export function forgetDesktopConnection(hostId: string): void {
  cancelIdle(hostId);
  let connection = desktops.get(hostId);
  desktops.delete(hostId);
  connection?.forget();
}

export function reviveDesktopConnections(reason?: RevivalReason): void {
  desktops.forEach((connection: DesktopConnection): void => connection.revive(reason));
}

export async function reconcileHomeDesktopConnections(candidates: HomeDesktopConnection[], current: () => boolean): Promise<void> {
  let statuses = await Promise.all(candidates.map((candidate: HomeDesktopConnection): Promise<DesktopCredentialStatus> =>
    candidate.connection.checkCredentialStatus()));
  if (!current()) { return; }
  let selected = new Set(candidates.filter((candidate: HomeDesktopConnection, index: number): boolean =>
    statuses[index] === 'ready' && candidate.host.publicKeyB64.length > 0)
    .sort((left: HomeDesktopConnection, right: HomeDesktopConnection): number =>
      right.host.lastConnected - left.host.lastConnected || left.host.id.localeCompare(right.host.id))
    .slice(0, HOME_AUTO_CONNECT_LIMIT).map((candidate: HomeDesktopConnection): string => candidate.host.id));
  candidates.forEach((candidate: HomeDesktopConnection): void => {
    if (!selected.has(candidate.host.id)) { candidate.connection.setHomeAutoConnect(false); }
  });
  candidates.forEach((candidate: HomeDesktopConnection): void => {
    if (selected.has(candidate.host.id)) { candidate.connection.setHomeAutoConnect(true); }
  });
}

export class DesktopConnection {
  private readonly context: common.UIAbilityContext;
  private readonly hostId: string;
  private readonly notifications: DesktopNotifications;
  private listeners: Set<DesktopListener> = new Set();
  private session: HostSession | null = null;
  private unsubscribeSession: (() => void) | null = null;
  private meta: HostMeta | null = null;
  private client: SpikeRpcClient | null = null;
  private phase: SessionPhase = 'idle';
  private detail: string = '';
  private credentialStatus: DesktopCredentialStatus = 'ready';
  private connectedAt: number | null = null;
  private automationCatalog: DesktopAutomationCatalog | null = null;
  private activePath: string = 'lan';
  private holders: number = 0;
  private scopedConnectionHolders: number = 0;
  private generation: number = 0;
  private profileRevision: number = 0;
  private credentialProbeRevision: number = 0;
  private opening: boolean = false;
  private wanted: boolean = false;
  private homeAutoConnect: boolean = false;
  private paused: boolean = false;
  private removed: boolean = false;

  constructor(context: common.UIAbilityContext, hostId: string) {
    this.context = context; this.hostId = hostId;
    this.notifications = new DesktopNotifications(context);
  }

  retain(demand?: LeaseDemand): void {
    this.holders++;
    if (demand) {
      this.scopedConnectionHolders++;
      if (demand === 'explicit') { this.paused = false; }
      this.startConnection(demand === 'explicit');
    }
  }

  release(demand?: LeaseDemand): boolean {
    this.holders--;
    if (demand) { this.scopedConnectionHolders--; }
    return this.holders === 0 || (demand !== undefined && !this.hasDemand());
  }

  closeIdle(): boolean {
    if (this.holders > 0) { this.stopIfUnused(); return false; }
    this.closeTransport(); return true;
  }

  observe(listener: DesktopListener): () => void {
    this.listeners.add(listener);
    listener(this.phase, this.detail);
    return (): void => { this.listeners.delete(listener); };
  }

  getPhase(): SessionPhase { return this.phase; }
  getCredentialStatus(): DesktopCredentialStatus { return this.credentialStatus; }
  getClient(): SpikeRpcClient | null { return this.client; }
  getPairedMeta(): HostMeta | null { return this.session ? this.meta : null; }
  getActivePath(): string { return this.activePath; }
  getPendingPath(): string | undefined { return this.session?.getPendingPath(); }
  getConnectedAt(): number | null { return this.connectedAt; }
  getReconnectAttempt(): number { return this.session?.getReconnectAttempt() ?? 0; }
  getRelayHostReachability(): string { return this.session?.getRelayHostReachability() ?? 'connecting'; }

  rememberAutomationCatalog(client: SpikeRpcClient, result: string): void {
    if (this.client === client) {
      this.automationCatalog = result.length <= 8 * 1024 * 1024 ? { result: result, readAt: Date.now() } : null;
    }
  }

  getAutomationCatalog(meta: HostMeta): DesktopAutomationCatalog | null {
    return meta.id === this.hostId && this.meta?.lastConnected === meta.lastConnected && this.meta?.endpoint === meta.endpoint
      ? this.automationCatalog : null;
  }

  private async readCredentials(): Promise<DesktopCredentials> {
    let token = await getDeviceToken(this.context, this.hostId);
    let relay = token ? await getRelayCredential(this.context, this.hostId) : null;
    return { token: token, relay: relay };
  }

  async checkCredentialStatus(): Promise<DesktopCredentialStatus> {
    if (this.session || this.removed) { return this.credentialStatus; }
    let generation = this.generation;
    let revision = ++this.credentialProbeRevision;
    let status: DesktopCredentialStatus;
    try { status = (await this.readCredentials()).token ? 'ready' : 'missing'; }
    catch (e) { status = 'temporarily-unavailable'; }
    if (generation === this.generation && revision === this.credentialProbeRevision && !this.session && !this.opening) {
      if (this.credentialStatus === 'missing' && status === 'ready' && this.phase === 'auth-failed') {
        this.phase = 'idle'; this.detail = '';
      }
      this.credentialStatus = status;
    }
    return this.credentialStatus;
  }

  setHomeAutoConnect(selected: boolean): void {
    if (this.removed) { return; }
    this.homeAutoConnect = selected;
    if (selected) { this.startConnection(false); }
    else { this.stopIfUnused(); }
  }

  private hasDemand(): boolean {
    return this.wanted || this.homeAutoConnect || this.scopedConnectionHolders > 0;
  }

  private stopIfUnused(): void {
    if (!this.hasDemand() && !this.paused && (this.session || this.opening)) {
      this.closeTransport(); this.publish('stopped', '已断开');
    }
  }

  setViewing(owner: Object, worktree: string, executionHost: string): void {
    this.notifications.setViewing(owner, this.hostId, worktree, executionHost);
  }

  clearViewing(owner: Object): void { this.notifications.clearViewing(owner); }

  private publish(phase: SessionPhase, detail: string): void {
    if (phase === 'auth-failed') { this.automationCatalog = null; }
    this.phase = phase; this.detail = detail;
    Array.from(this.listeners).forEach((listener: DesktopListener): void => listener(phase, detail));
  }

  private closeTransport(): void {
    this.generation++; this.profileRevision++; this.opening = false;
    this.unsubscribeSession?.(); this.unsubscribeSession = null;
    this.notifications.stop(); this.client = null;
    let previous = this.session; this.session = null;
    previous?.stop();
  }

  connect(explicit: boolean = false): void {
    if (this.removed || this.holders === 0 || (this.paused && !explicit)) { return; }
    if (explicit) { this.paused = false; }
    this.wanted = true;
    this.startConnection(explicit);
  }

  private startConnection(explicit: boolean): void {
    if (this.removed || this.holders === 0 || this.paused) { return; }
    if (this.opening || this.session || (!explicit && this.phase === 'auth-failed')) { return; }
    let generation = ++this.generation;
    this.opening = true; this.publish('connecting', '正在连接');
    this.open(generation).catch(() => {
      if (generation !== this.generation) { return; }
      this.opening = false; this.publish('stopped', '无法连接桌面');
    });
  }

  private async open(generation: number): Promise<void> {
    let hosts = await listHosts(this.context);
    if (generation !== this.generation) { return; }
    let meta = hosts.find((host: HostMeta): boolean => host.id === this.hostId);
    if (!meta) {
      this.opening = false; this.publish('stopped', '主机不存在'); return;
    }
    this.meta = meta;
    let credentials: DesktopCredentials;
    try {
      credentials = await this.readCredentials();
    } catch (e) {
      if (generation !== this.generation) { return; }
      this.credentialStatus = 'temporarily-unavailable';
      this.opening = false; this.publish('stopped', '无法读取桌面凭证'); return;
    }
    if (generation !== this.generation) { return; }
    if (!credentials.token) {
      this.credentialStatus = 'missing';
      this.opening = false; this.publish('auth-failed', '凭证缺失 — 请重新配对'); return;
    }
    this.credentialStatus = 'ready';
    let session = new HostSession(meta, credentials.token, credentials.relay ?? undefined, this.context);
    this.opening = false; this.session = session;
    this.unsubscribeSession = session.addListener((phase: SessionPhase, detail: string): void => {
      if (this.session !== session) { return; }
      let client = phase === 'connected' ? session.getClient() : null;
      if (this.client !== client) {
        this.client = client;
        if (client) {
          this.connectedAt = session.getConnectedAt(); this.activePath = session.getActivePath();
          this.notifications.attach(client, this.hostId);
        } else { this.notifications.stop(); }
      }
      this.publish(phase, detail);
    });
    session.start();
  }

  reconnect(retainManualDemand: boolean = true): void {
    if (this.removed) { return; }
    this.paused = false;
    if (retainManualDemand) { this.wanted = true; }
    // Keep a healthy Relay path while checking that it still answers.
    if (this.phase === 'connected' && this.activePath === 'relay') { this.session?.revive(); return; }
    this.closeTransport(); this.startConnection(true);
  }

  disconnect(): void {
    this.wanted = false; this.paused = true;
    this.closeTransport(); this.publish('stopped', this.removed ? '主机不存在' : '已断开');
  }

  forget(): void { this.removed = true; this.meta = null; this.automationCatalog = null; this.disconnect(); }

  refresh(change: ProfileChange): void {
    if (this.removed) { return; }
    let revision = ++this.profileRevision;
    if (change === 'paired' || change === 'endpoint') {
      if (change === 'paired') { this.paused = false; }
      this.replaceTransport();
      return;
    }
    listHosts(this.context).then((hosts: HostMeta[]): void => {
      if (revision !== this.profileRevision || this.removed) { return; }
      let next = hosts.find((host: HostMeta): boolean => host.id === this.hostId);
      if (next) { this.updateProfile(next); }
    }).catch(() => {});
  }

  updateProfile(next: HostMeta): void {
    let meta = this.meta;
    if (!meta) { return; }
    if (meta.endpoint !== next.endpoint || meta.lastConnected !== next.lastConnected) {
      let paired = meta.lastConnected !== next.lastConnected;
      if (paired) { this.paused = false; }
      this.replaceTransport();
      return;
    }
    meta.name = next.name; meta.machineName = next.machineName; meta.personalName = next.personalName;
    meta.hostPlatform = next.hostPlatform; meta.hostMachine = next.hostMachine;
  }

  private replaceTransport(): void {
    this.closeTransport(); this.meta = null; this.automationCatalog = null;
    if (this.hasDemand() && !this.paused) { this.startConnection(true); }
    else { this.publish('stopped', '已断开'); }
  }

  revive(reason?: RevivalReason): void {
    if (this.removed || this.paused || !this.hasDemand()) { return; }
    if (reason) {
      let network = reason === 'network-change';
      appendLog(this.context, LOG_LEVEL_INFO, network ? 'Network changed' : 'App resumed', '', this.hostId,
        network ? 'network-changed' : 'app-resumed').catch(() => {});
    }
    if (this.session) { this.session.revive(reason === 'network-change'); }
    else { this.startConnection(false); }
  }
}
