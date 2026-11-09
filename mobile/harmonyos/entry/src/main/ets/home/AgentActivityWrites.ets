import { AgentActivityChange } from './AgentListModel';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';

interface AgentActivityArgs { paneKeys: string[]; read?: boolean; }
interface PendingActivity { change: AgentActivityChange; stamp: number; }

const BATCH_SIZE = 500;

export class AgentActivityWrites {
  private stamp: number = 0;
  private pending = new Map<string, Map<string, PendingActivity>>();
  private writes = new Map<string, Promise<string>>();
  private changed: () => void;

  constructor(changed: () => void) { this.changed = changed; }

  snapshot(hostId: string): Record<string, AgentActivityChange> {
    let result: Record<string, AgentActivityChange> = {};
    this.pending.get(hostId)?.forEach((item: PendingActivity, paneKey: string): void => {
      result[`${hostId}:${paneKey}`] = item.change;
    });
    return result;
  }

  forget(hostId: string): void {
    this.pending.delete(hostId);
    this.writes.delete(hostId);
  }

  async write(hostId: string, paneKeys: string[], read: boolean | undefined, client: SpikeRpcClient,
    isCurrent: () => boolean, refresh: () => Promise<void>): Promise<string> {
    if (!isCurrent()) { return 'unavailable'; }
    let stamp = ++this.stamp;
    let pending = this.pending.get(hostId) ?? new Map<string, PendingActivity>();
    let change: AgentActivityChange = read === undefined ? { cleared: true } : { unread: !read };
    paneKeys.forEach((key: string): void => { pending.set(key, { change: change, stamp: stamp }); });
    this.pending.set(hostId, pending);
    this.changed();

    let previous = this.writes.get(hostId) ?? Promise.resolve('');
    let next = previous.then((): Promise<string> => this.send(client, paneKeys, read, isCurrent));
    this.writes.set(hostId, next);
    try {
      let result = await next;
      if (isCurrent()) { await refresh().catch(() => {}); }
      return result;
    } finally {
      if (this.writes.get(hostId) === next) { this.writes.delete(hostId); }
      if (this.pending.get(hostId) === pending) {
        paneKeys.forEach((key: string): void => {
          if (pending.get(key)?.stamp === stamp) { pending.delete(key); }
        });
        if (pending.size === 0) { this.pending.delete(hostId); }
        this.changed();
      }
    }
  }

  private async send(client: SpikeRpcClient, paneKeys: string[], read: boolean | undefined,
    isCurrent: () => boolean): Promise<string> {
    try {
      for (let start = 0; start < paneKeys.length; start += BATCH_SIZE) {
        if (!isCurrent()) { return 'unavailable'; }
        let args: AgentActivityArgs = { paneKeys: paneKeys.slice(start, start + BATCH_SIZE) };
        if (read !== undefined) { args.read = read; }
        let response = await client.request(read === undefined ? 'agentActivity.clear' : 'agentActivity.setRead', JSON.stringify(args));
        if (!(response instanceof RpcSuccess)) {
          return response.errorMessage.includes('agent_activity_needs_desktop_window')
            ? 'agent_activity_needs_desktop_window' : response.errorCode || 'refused';
        }
        let accepted: ESObject = JSON.parse(response.result);
        if (accepted?.['applied'] !== true) { return 'refused'; }
      }
      return '';
    } catch (e) { return 'refused'; }
  }
}
