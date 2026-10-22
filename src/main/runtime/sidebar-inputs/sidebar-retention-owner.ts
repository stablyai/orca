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
  /** The keys the workspaces domain lists this host's rows under; readers match retention on them. */
  listRowKeys: () => Promise<readonly HostScopedWorktreeKey[]>
  retentionCandidates: () => SidebarRetentionCandidates
}

const RETENTION_DEADLINE = 'sleeping-retention'

/**
 * Main's copy of which sleeping rows "Hide sleeping" still keeps through a rebind gap. The window
 * runs its own; this one is compared against it. It stays idle until a window begins a session.
 */
export class SidebarRetentionOwner {
  readonly revision = new ProducerRevision()
  private sessionId: string | null = null
  private disposed = false
  // A listing started before a reset or a later one must not land.
  private listingSeq = 0
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
    this.relist()
  }

  /** A worktree or repo change: list again, so new rows' hosts are known. */
  noteCatalogChange(): void {
    if (this.running) {
      this.relist()
    }
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
    this.listingSeq += 1
    this.clock.cancel(RETENTION_DEADLINE)
  }

  /** False until a window begins a session, and after dispose. */
  get running(): boolean {
    return this.sessionId !== null && !this.disposed
  }

  private relist(): void {
    const seq = ++this.listingSeq
    void this.inputs.listRowKeys().then(
      (keys) => {
        if (seq === this.listingSeq && this.running) {
          this.applyListing(keys)
        }
      },
      (error: unknown) => console.warn('[sidebar-retention] could not list rows', error)
    )
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
