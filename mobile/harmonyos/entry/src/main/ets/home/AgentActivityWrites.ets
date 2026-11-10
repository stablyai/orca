import { AgentActivityChange, AgentListRow, HomeAgentEntry } from './AgentListModel';
import { SpikeRpcClient, RpcSuccess } from '../transport/SpikeRpcClient';

interface AgentActivityArgs { paneKeys: string[]; read?: boolean; }
interface PendingActivity { change: AgentActivityChange; stamp: number; }
export interface AgentActivityBatch { hostId: string; executionHost: string; paneKeys: string[]; }
interface AgentActivityPlan { batches: AgentActivityBatch[]; unavailable: boolean; }

const BATCH_SIZE = 500;

export function planAgentActivity(rows: AgentListRow[], read: boolean | undefined,
  catalogFor: (hostId: string) => HomeAgentEntry[]): AgentActivityPlan {
  let catalogs = new Map<string, Map<string, HomeAgentEntry | null>>();
  let batches = new Map<string, AgentActivityBatch>();
  let unavailable = false;
  rows.forEach((row: AgentListRow): void => {
    if (row.offline || (read === undefined ? !row.clearable : row.unread === undefined)) { return; }
    let catalog = catalogs.get(row.hostId);
    if (!catalog) {
      let indexed = new Map<string, HomeAgentEntry | null>();
      catalogFor(row.hostId).forEach((entry: HomeAgentEntry): void => {
        let paneKey = String(entry.agent['paneKey']);
        indexed.set(paneKey, indexed.has(paneKey) ? null : entry);
      });
      catalogs.set(row.hostId, indexed);
      catalog = indexed;
    }
    let paneKey = String(row.entry.agent['paneKey']);
    let entry = catalog.get(paneKey);
    if (!entry || entry.ambiguousWorkspace || entry.worktreeId !== row.entry.worktreeId
      || entry.workspaceIdentityKey !== row.entry.workspaceIdentityKey || entry.executionHostId !== row.entry.executionHostId
      || entry.executionHost !== row.entry.executionHost
      || (entry.executionHostId?.startsWith('runtime:') && entry.executionHost !== entry.executionHostId)) {
      unavailable = true; return;
    }
    let key = JSON.stringify([row.hostId, entry.executionHost]);
    let batch: AgentActivityBatch = batches.get(key) ?? { hostId: row.hostId, executionHost: entry.executionHost, paneKeys: [] };
    if (!batch.paneKeys.includes(paneKey)) { batch.paneKeys.push(paneKey); }
    batches.set(key, batch);
  });
  return { batches: Array.from(batches.values()), unavailable: unavailable };
}

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
    isCurrent: () => boolean, refresh: () => Promise<void>, executionHost?: string): Promise<string> {
    if (!isCurrent()) { return 'unavailable'; }
    let stamp = ++this.stamp;
    let pending = this.pending.get(hostId) ?? new Map<string, PendingActivity>();
    let change: AgentActivityChange = read === undefined ? { cleared: true } : { unread: !read };
    paneKeys.forEach((key: string): void => { pending.set(key, { change: change, stamp: stamp }); });
    this.pending.set(hostId, pending);
    this.changed();

    let previous = this.writes.get(hostId) ?? Promise.resolve('');
    let next = previous.then((): Promise<string> => this.send(client, paneKeys, read, isCurrent, executionHost));
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
    isCurrent: () => boolean, executionHost?: string): Promise<string> {
    try {
      for (let start = 0; start < paneKeys.length; start += BATCH_SIZE) {
        if (!isCurrent()) { return 'unavailable'; }
        let args: AgentActivityArgs = { paneKeys: paneKeys.slice(start, start + BATCH_SIZE) };
        if (read !== undefined) { args.read = read; }
        let response = await client.request(read === undefined ? 'agentActivity.clear' : 'agentActivity.setRead',
          JSON.stringify(args), undefined, executionHost);
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
