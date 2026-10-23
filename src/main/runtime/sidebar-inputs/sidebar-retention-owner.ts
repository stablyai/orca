import { ProducerRevision } from './producer-revision'
import { getWorktreeIdFromHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from '../../../shared/sidebar-list/sleeping-sweep-retention'
import type {
  SidebarRetention,
  SidebarTemporalSnapshot
} from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { SidebarClock } from './sidebar-clock'

/** The sweep's view of one workspace, by bare id. */
export type SidebarRetentionCandidates = {
  /** Active ids; the last listing's rows are added to them. */
  ids: Iterable<string>
  isActive: (worktreeId: string) => boolean
  /** False when the inactivity is definitive: a sleep this host started, or no terminal tab left. */
  isUnverifiableGap: (worktreeId: string) => boolean
}

export type SidebarRetentionInputs = {
  showSleepingWorkspaces: () => boolean
  /** The keys the workspaces domain lists this host's rows under; readers match retention on them. */
  listRowKeys: () => Promise<readonly string[]>
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
  // Both of a same-id pair on two hosts: the sweep and activity are by bare id.
  private keysById = new Map<string, string[]>()
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

  private applyListing(keys: readonly string[]): void {
    if (!this.listed) {
      this.listed = true
      this.revision.bump()
    }
    this.keysById = new Map()
    for (const key of keys) {
      const id = getWorktreeIdFromHostIdentity(key)
      this.keysById.set(id, [...(this.keysById.get(id) ?? []), key])
    }
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
    const { retainedIds, nextExpiryInMs } = updateSleepingSweepRetention({
      state: this.retentionState,
      // The last listing's rows too, so an id that just went idle is not pruned out of its grace.
      candidateWorktreeIds: [...new Set([...candidates.ids, ...this.keysById.keys()])],
      isActive: candidates.isActive,
      isUnverifiableGap: candidates.isUnverifiableGap,
      nowMs: now
    })
    if (nextExpiryInMs === null) {
      this.clock.cancel(RETENTION_DEADLINE)
    } else {
      this.clock.schedule(RETENTION_DEADLINE, now + nextExpiryInMs, () => this.retentionPass())
    }
    // An id no listing has carried yet has no host to qualify it with, so it waits for one.
    const ids = [...retainedIds].flatMap((id) => this.keysById.get(id) ?? []).sort()
    const previous = this.retention?.retainedIds
    if (!previous || previous.length !== ids.length || previous.some((id, i) => id !== ids[i])) {
      this.retention = { retainedIds: ids, retentionDecidedAt: now }
      this.revision.bump()
    }
  }
}
