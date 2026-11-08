import { SpikeRpcClient, RpcResponse, RpcSuccess } from './SpikeRpcClient';
import { HostMeta } from '../storage/HostStore';

export type SessionPhase = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';
type Listener = (phase: SessionPhase, detail: string) => void;

/** One physical client per attempt, one probe at a time, and one reconnect timer. */
export class HostSession {
  private client: SpikeRpcClient | null = null;
  private meta: HostMeta;
  private token: string;
  private stopped: boolean = true;
  private attempt: number = 0;
  private reconnectTimer: number = -1;
  private probeTimer: number = -1;
  private listeners: Listener[] = [];
  private logSink: ((line: string) => void) | null = null;
  private setup: ((client: SpikeRpcClient) => void) | null = null;

  constructor(meta: HostMeta, token: string) { this.meta = meta; this.token = token; }
  setLogSink(sink: (line: string) => void): void { this.logSink = sink; }
  setClientSetup(setup: (client: SpikeRpcClient) => void): void { this.setup = setup; }
  addListener(listener: Listener): void { this.listeners.push(listener); }
  getClient(): SpikeRpcClient | null { return this.client; }
  private publish(phase: SessionPhase, detail: string): void {
    for (let i = 0; i < this.listeners.length; i++) { this.listeners[i](phase, detail); }
  }
  private log(line: string): void { if (this.logSink) { this.logSink(line); } }
  start(): void { if (!this.stopped) { return; } this.stopped = false; this.dial(); }
  stop(): void {
    this.stopped = true; this.clearTimers();
    let old = this.client; this.client = null;
    if (old) { old.close(); }
    this.publish('stopped', '已断开');
  }
  private clearTimers(): void {
    if (this.reconnectTimer >= 0) { clearTimeout(this.reconnectTimer); this.reconnectTimer = -1; }
    if (this.probeTimer >= 0) { clearTimeout(this.probeTimer); this.probeTimer = -1; }
  }
  private dial(): void {
    if (this.stopped) { return; }
    this.clearTimers();
    let client = new SpikeRpcClient(); this.client = client;
    client.setLogSink((line: string): void => this.log(line));
    if (this.setup) { this.setup(client); }
    client.onSocketClosed((): void => this.retry(client));
    this.publish(this.attempt === 0 ? 'connecting' : 'reconnecting', '正在连接');
    client.connect(this.meta.endpoint, this.token, this.meta.publicKeyB64, 'v2').then((): void => {
      if (this.stopped || this.client !== client) { client.close(); return; }
      this.attempt = 0;
      this.publish('connected', this.meta.name);
      this.probeLater(client);
    }).catch((_e: Error): void => this.retry(client));
  }
  private retry(client: SpikeRpcClient): void {
    if (this.stopped || this.client !== client || this.reconnectTimer >= 0) { return; }
    this.clearTimers(); this.client = null; client.close();
    this.attempt++;
    let delay = Math.min(10000, 1000 * Math.pow(2, Math.min(this.attempt - 1, 4)));
    this.log('连接中断，正在重试');
    this.publish('reconnecting', `${Math.ceil(delay / 1000)} 秒后重试`);
    this.reconnectTimer = setTimeout((): void => { this.reconnectTimer = -1; this.dial(); }, delay);
  }
  private probeLater(client: SpikeRpcClient): void {
    this.probeTimer = setTimeout((): void => {
      this.probeTimer = -1;
      if (this.stopped || this.client !== client) { return; }
      client.request('status.get', null, 5000).then((response: RpcResponse): void => {
        if (this.stopped || this.client !== client) { return; }
        if (response instanceof RpcSuccess) { this.probeLater(client); }
        else { this.retry(client); }
      }).catch((): void => this.retry(client));
    }, 20000);
  }
}
