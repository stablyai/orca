import { ProducerRevision } from './producer-revision'
import {
  getWorktreeIdFromHostIdentity,
  type HostScopedWorktreeKey
} from '../../../shared/worktree/host-qualified-identity'
import {
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from '../../../shared/sidebar-list/sleeping-sweep-retention'
import type {
  SidebarRetention,
  SidebarTemporalSnapshot
} from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { SidebarClock } from './sidebar-clock'

/** This host's activity by bare id, read for each listed row: its session names no host. */
export type SidebarRetentionCandidates = {
  isActive: (worktreeId: string) => boolean
  /** False when the inactivity is definitive: a sleep this host started, or no terminal tab left. */
  isUnverifiableGap: (worktreeId: string) => boolean
}

export type SidebarRetentionInputs = {
  showSleepingWorkspaces: () => boolean
  /** The keys the workspaces domain lists this host's rows under; null before its first scan. */
  rowKeys: () => readonly HostScopedWorktreeKey[] | null
  /** Calls `changed` whenever those rows may have changed; returns the detach. */
  watchRowKeys: (changed: () => void) => () => void
  retentionCandidates: () => SidebarRetentionCandidates
}

const RETENTION_DEADLINE = 'sleeping-retention'

/** Compare main/window sleeping-row retention across rebind gaps; main remains idle until a window starts a list session. */
export class SidebarRetentionOwner {
  readonly revision = new ProducerRevision()
  private sessionId: string | null = null
  private disposed = false
  private detachRows: (() => void) | null = null
  private relistQueued = false
  // The last listing's rows; the sweep keeps a grace window per row, not per bare id.
  private listedKeys: readonly HostScopedWorktreeKey[] = []
  private retentionState = createSleepingSweepRetentionState()
  private retention: SidebarRetention | null = null
  // Until a listing lands no retained id can be host-qualified, so nothing is published.
  private listed = false

  constructor(
    private readonly clock: SidebarClock,
    private readonly inputs: SidebarRetentionInputs
  ) {}

  snapshot(): SidebarTemporalSnapshot {
    return {
      revision: this.revision.value,
      sessionId: this.sessionId,
      retention: this.listed ? this.retention : null
    }
  }

  /** The window mounted its list: retention forgets, as on today's remount. */
  beginSession(sessionId: string): void {
    if (sessionId === this.sessionId) {
      return
    }
    this.sessionId = sessionId
    this.retentionState = createSleepingSweepRetentionState()
    this.revision.bump()
    this.retentionPass()
    // The rows' own revision, so a new row's host is known as soon as the rows list it.
    this.detachRows ??= this.inputs.watchRowKeys(() => this.relist())
    this.relist()
  }

  noteActivityChange(): void {
    this.retentionPass()
  }

  /** The sleeping filter may have changed. */
  noteViewChange(): void {
    this.retentionPass()
  }

  dispose(): void {
    this.disposed = true
    this.detachRows?.()
    this.detachRows = null
    this.clock.cancel(RETENTION_DEADLINE)
  }

  /** False until a window begins a session, and after dispose. */
  get running(): boolean {
    return this.sessionId !== null && !this.disposed
  }

  // A microtask: a revision listener hears the bump mid-change, so the rows are read after it.
  private relist(): void {
    if (this.relistQueued) {
      return
    }
    this.relistQueued = true
    queueMicrotask(() => {
      this.relistQueued = false
      const keys = this.running ? this.inputs.rowKeys() : null
      if (keys) {
        this.applyListing(keys)
      }
    })
  }

  private applyListing(keys: readonly HostScopedWorktreeKey[]): void {
    if (!this.listed) {
      this.listed = true
      this.revision.bump()
    }
    this.listedKeys = keys
    this.retentionPass()
  }

  private retentionPass(): void {
    if (!this.running) {
      return
    }
    if (this.inputs.showSleepingWorkspaces()) {
      this.retentionState = createSleepingSweepRetentionState()
      this.clock.cancel(RETENTION_DEADLINE)
      if (this.retention !== null) {
        this.retention = null
        this.revision.bump()
      }
      return
    }
    const candidates = this.inputs.retentionCandidates()
    const now = Date.now()
    // Every listed row is a candidate, so one that just went idle is not pruned out of its grace.
    const { retainedIds, nextExpiryInMs } = updateSleepingSweepRetention({
      state: this.retentionState,
      candidateWorktreeIds: this.listedKeys,
      isActive: (key) => candidates.isActive(getWorktreeIdFromHostIdentity(key)),
      isUnverifiableGap: (key) => candidates.isUnverifiableGap(getWorktreeIdFromHostIdentity(key)),
      nowMs: now
    })
    if (nextExpiryInMs === null) {
      this.clock.cancel(RETENTION_DEADLINE)
    } else {
      this.clock.schedule(RETENTION_DEADLINE, now + nextExpiryInMs, () => this.retentionPass())
    }
    const ids = [...retainedIds].sort()
    const previous = this.retention?.retainedIds
    if (!previous || previous.length !== ids.length || previous.some((id, i) => id !== ids[i])) {
      this.retention = { retainedIds: ids, retentionDecidedAt: now }
      this.revision.bump()
    }
  }
}
