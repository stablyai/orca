// Reads of settled workers kept between refreshes, so a refresh re-reads only running workers and those
// whose rows changed since. Each read names every Dispatch it walked; a write to any of them drops it.
import type { AgentStatusIpcPayload } from '../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import type { DispatchRowChange } from '../runtime/orchestration/db/worker-status-notice'

export const SETTLED_WORKER_STATES = new Set<OrchestrationSessionWorker['state']>([
  'completed',
  'failed',
  'stopped'
])

type Entry<T> = { value: T; group: string }
/** Reads that rest on the same Dispatches (one worker's lineage), indexed once however many refs use it. */
type Group = { walked: Set<string>; reads: Set<string>; merged: WeakSet<ReadonlySet<string>> }

export class SettledDispatchReadCache<T> {
  private readonly scopes = new Map<string, Map<string, Entry<T>>>()
  private readonly groups = new Map<string, Group>()
  /** Each walked Dispatch's groups. */
  private readonly groupsOf = new Map<string, Set<string>>()
  /** Bumped by every drop; a read only stores what nothing dropped while it ran. */
  private epoch = 0
  private clearedAt = 0
  private insertedAt = 0
  private readonly droppedAt = new Map<string, number>()
  private readonly inserted = new Set<string>()
  /** Walked sets already checked against drops, at an epoch and start, with the answer. */
  private readonly checked = new WeakMap<
    ReadonlySet<string>,
    { stamp: string; unchanged: boolean }
  >()
  /** Scopes forgotten by `keepScopes`, so a read begun before cannot bring one back. */
  private readonly scopeDroppedAt = new Map<string, number>()
  private source: unknown = null

  /** `followsInserts`: a new Dispatch can extend a kept read's walk (a follow-up), so inserts are kept
   *  for `takeInserted` and no read that started before one stores. */
  constructor(
    private readonly max: number,
    private readonly followsInserts = false
  ) {}

  /** A read's start, against the database it reads (another one drops every read). */
  begin(source: unknown): number {
    if (source !== this.source) {
      this.source = source
      this.drop(null)
    }
    return this.epoch
  }

  /** Whether `value` is still what `key` keeps (a drop since removed it). */
  holds(scope: string, key: string, value: T): boolean {
    return this.scopes.get(scope)?.get(key)?.value === value
  }

  get(scope: string, key: string): T | undefined {
    const entries = this.scopes.get(scope)
    const entry = entries?.get(key)
    if (!entries || !entry) {
      return undefined
    }
    // Most recently used last, so the oldest falls out first.
    entries.delete(key)
    entries.set(key, entry)
    return entry.value
  }

  /** Keeps a read begun at `started` in `group`, unless a Dispatch it walked was written since. Reads
   *  that share a group pass one walked set, which is checked and indexed once. */
  set(
    scope: string,
    key: string,
    value: T,
    group: string,
    walked: ReadonlySet<string>,
    started: number
  ): void {
    if (
      this.clearedAt > started ||
      this.insertedAt > started ||
      (this.scopeDroppedAt.get(scope) ?? 0) > started ||
      !this.unchanged(walked, started)
    ) {
      return
    }
    let entries = this.scopes.get(scope)
    if (!entries) {
      entries = new Map()
      this.scopes.set(scope, entries)
    }
    this.remove(scope, key)
    entries.set(key, { value, group })
    let kept = this.groups.get(group)
    if (!kept) {
      kept = { walked: new Set(), reads: new Set(), merged: new WeakSet() }
      this.groups.set(group, kept)
    }
    if (!kept.merged.has(walked)) {
      kept.merged.add(walked)
      for (const id of walked) {
        if (!kept.walked.has(id)) {
          kept.walked.add(id)
          const groups = this.groupsOf.get(id) ?? new Set()
          groups.add(group)
          this.groupsOf.set(id, groups)
        }
      }
    }
    kept.reads.add(readId(scope, key))
    for (const oldest of entries.keys()) {
      if (entries.size <= this.max) {
        break
      }
      this.remove(scope, oldest)
    }
  }

  /** Forgets the reads of scopes no longer on the host. */
  keepScopes(scopes: readonly string[]): void {
    const live = new Set(scopes)
    for (const [scope, entries] of this.scopes) {
      if (!live.has(scope)) {
        for (const key of entries.keys()) {
          this.remove(scope, key)
        }
        this.scopes.delete(scope)
        this.epoch += 1
        this.scopeDroppedAt.set(scope, this.epoch)
      }
    }
  }

  /** The database's notice of a Dispatch row write; one to a row no Dispatch owns changes no read. */
  rowChanged(dispatchId: string | null, change: DispatchRowChange): void {
    if (change === 'inserted' && dispatchId !== null && this.followsInserts) {
      // Any read in flight may have walked what this continues; with nothing kept, none needs the id.
      this.epoch += 1
      this.insertedAt = this.epoch
      if (this.groups.size > 0) {
        this.inserted.add(dispatchId)
      }
      if (this.inserted.size > this.max) {
        this.inserted.clear()
        this.drop(null)
      }
    }
    if (dispatchId !== null || change === 'deleted') {
      this.drop(dispatchId)
    }
  }

  /** Dispatches inserted since the last call; the reader drops what each one continues. */
  takeInserted(): string[] {
    const ids = [...this.inserted]
    this.inserted.clear()
    return ids
  }

  /** These Dispatches' rows changed; null drops every read (a reset). */
  drop(dispatchId: string | readonly string[] | null): void {
    if (dispatchId !== null && typeof dispatchId !== 'string') {
      for (const id of dispatchId) {
        this.drop(id)
      }
      return
    }
    this.epoch += 1
    if (dispatchId === null) {
      this.scopes.clear()
      this.groups.clear()
      this.groupsOf.clear()
      this.droppedAt.clear()
      this.scopeDroppedAt.clear()
      this.clearedAt = this.epoch
      return
    }
    for (const group of Array.from(this.groupsOf.get(dispatchId) ?? [])) {
      for (const read of Array.from(this.groups.get(group)?.reads ?? [])) {
        const [scope, key] = read.split('\0')
        this.remove(scope, key)
      }
    }
    this.droppedAt.set(dispatchId, this.epoch)
    if (this.droppedAt.size > this.max) {
      // Older drops only guard reads that started before them; forgetting them all is as safe as a reset.
      this.droppedAt.clear()
      this.clearedAt = this.epoch
    }
  }

  /** No Dispatch of `walked` was dropped since `started`; one check per set until the next drop. */
  private unchanged(walked: ReadonlySet<string>, started: number): boolean {
    const stamp = `${this.epoch}:${started}`
    const checked = this.checked.get(walked)
    if (checked?.stamp === stamp) {
      return checked.unchanged
    }
    let unchanged = true
    for (const id of walked) {
      if ((this.droppedAt.get(id) ?? 0) > started) {
        unchanged = false
        break
      }
    }
    this.checked.set(walked, { stamp, unchanged })
    return unchanged
  }

  private remove(scope: string, key: string): void {
    const entries = this.scopes.get(scope)
    const entry = entries?.get(key)
    if (!entries || !entry) {
      return
    }
    entries.delete(key)
    const group = this.groups.get(entry.group)
    group?.reads.delete(readId(scope, key))
    if (group?.reads.size === 0) {
      this.groups.delete(entry.group)
      for (const id of group.walked) {
        const groups = this.groupsOf.get(id)
        groups?.delete(entry.group)
        if (groups?.size === 0) {
          this.groupsOf.delete(id)
        }
      }
    }
  }
}

function readId(scope: string, key: string): string {
  return `${scope}\0${key}`
}

/** The live status a worker's read took its agent and host from; a kept read whose status since
 *  changed (a host reconnected, an agent exited) is read again. */
export function workerStatusEvidence(
  rows: readonly AgentStatusIpcPayload[]
): (worker: Pick<OrchestrationSessionWorker, 'paneKey' | 'address'>) => string {
  const byPane = new Map<string, AgentStatusIpcPayload>()
  const byHandle = new Map<string, AgentStatusIpcPayload>()
  for (const row of rows) {
    byPane.set(row.paneKey, row)
    if (row.terminalHandle) {
      byHandle.set(row.terminalHandle, row)
    }
  }
  const key = (row: AgentStatusIpcPayload | undefined): string =>
    row ? `${row.agentType ?? ''}|${row.connectionId ?? ''}` : ''
  // A worker's row is matched by its pane, else by its terminal handle.
  return (worker) =>
    `${key(worker.paneKey ? byPane.get(worker.paneKey) : undefined)}/${key(
      worker.address ? byHandle.get(worker.address) : undefined
    )}`
}
