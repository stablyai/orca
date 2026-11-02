import { ProducerRevision } from './producer-revision'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  CREATE_GRACE_MS,
  type WorkspaceSortBy
} from '../../../shared/workspace-view/workspace-row-sort'
import {
  INITIAL_SORT_SETTLE_STATE,
  reduceSortSettle,
  type SortSettleEvent
} from '../../../shared/sidebar-list/sort-settle'
import { ranksFollowPersistedOrder } from '../../../shared/sidebar-list/smart-sort-phase'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import {
  rankWorktreesForSort,
  type SmartSortSources
} from '../../../shared/sidebar-list/smart-sort'
import {
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from '../../../shared/sidebar-list/sleeping-sweep-retention'
import type {
  SidebarRetention,
  SidebarSortSnapshot,
  SidebarTemporalSnapshot
} from '../../../shared/sidebar-list/sidebar-temporal-snapshot'
import type { SidebarClock } from './sidebar-clock'
import {
  classifyCatalogListingChange,
  countLiveRows,
  indexCatalogListing,
  type CatalogListing
} from './catalog-listing-change'

/** What one settle sorts: every row this host lists, and the records Smart scores. */
export type SidebarSortSample = {
  worktrees: Worktree[]
  repoMap: Map<string, Pick<Repo, 'displayName'>>
  sources: SmartSortSources
}

/** The sweep's view of one workspace, by bare id. */
export type SidebarRetentionCandidates = {
  /** Active ids; the last sample's rows are added to them. */
  ids: Iterable<string>
  isActive: (worktreeId: string) => boolean
  /** False when the inactivity is definitive: a sleep this host started, or no terminal tab left. */
  isUnverifiableGap: (worktreeId: string) => boolean
}

export type SidebarTemporalInputs = {
  sortBy: () => WorkspaceSortBy
  showSleepingWorkspaces: () => boolean
  /** May scan the host's worktrees; a later settle supersedes a slow read. */
  readSortSample: () => Promise<SidebarSortSample>
  retentionCandidates: () => SidebarRetentionCandidates
}

const SETTLE_DEADLINE = 'sort-settle'

const CREATE_GRACE_DEADLINE = 'create-grace'
const RETENTION_DEADLINE = 'sleeping-retention'

/**
 * Main's copy of the list's time rules: when the frozen order settles, whether Smart has latched,
 * and which sleeping rows the sweep still keeps. The window still runs its own; this one is
 * compared against it and never persists ranks. It stays idle until a window begins a session.
 */
export class SidebarTemporalOwner {
  readonly revision = new ProducerRevision()
  private sessionId: string | null = null
  private disposed = false
  private settleState = INITIAL_SORT_SETTLE_STATE
  private sortBy: WorkspaceSortBy
  private smartLatched = false
  private epoch = 0
  private sortSnapshot: SidebarSortSnapshot | null = null
  // A sample started before a reset or a later settle must not land.
  private sampleSeq = 0
  private identityById = new Map<string, string>()
  private retentionState = createSleepingSweepRetentionState()
  private retention: SidebarRetention | null = null
  // The last listing, as the window's catalog would hold it.
  private listing: CatalogListing = new Map()
  // The window's settle baseline is the catalog it already holds, so a session's first rows set main's.
  private seedRows = false

  constructor(
    private readonly clock: SidebarClock,
    private readonly inputs: SidebarTemporalInputs
  ) {
    this.sortBy = inputs.sortBy()
  }

  snapshot(): SidebarTemporalSnapshot {
    return {
      revision: this.revision.value,
      sessionId: this.sessionId,
      sortSnapshot: this.sortSnapshot,
      retention: this.retention
    }
  }

  /** The window mounted its list: Smart goes cold and retention forgets, as on today's remount. */
  beginSession(sessionId: string): void {
    if (sessionId === this.sessionId) {
      return
    }
    this.sessionId = sessionId
    this.sortBy = this.inputs.sortBy()
    this.smartLatched = false
    this.epoch = 0
    // Until the new session's first sample lands, a reader must not take the old warm ranks.
    this.sortSnapshot = null
    this.retentionState = createSleepingSweepRetentionState()
    this.seedRows = true
    this.revision.bump()
    this.retentionPass()
    this.settleNow()
  }

  /** A change the sort reads; it settles after the burst, or at once when the row count moved. */
  noteSortInputChange(liveWorktreeCount?: number): boolean {
    return this.dispatchSettle({
      kind: 'write',
      change: {
        epochBumped: true,
        liveCount: liveWorktreeCount ?? this.settleState.liveCountAtLastBump
      },
      settled: false,
      sortBy: this.sortBy,
      previousSortBy: this.sortBy
    })
  }

  /**
   * The catalog was listed again after a worktree or repo change. Mirrors the window's merge: a
   * row change bumps the sort, a sortOrder-only save re-ranks only Manual and cold Smart, and a
   * repo change re-sorts at once since repo labels are a sort key.
   */
  noteCatalogListing(worktrees: readonly Worktree[], repoChanged: boolean): void {
    if (!this.running) {
      return
    }
    const previous = this.listing
    this.listing = indexCatalogListing(worktrees)
    const liveCount = countLiveRows(worktrees)
    if (this.takeRowsSeed(liveCount)) {
      // The session's first sample may have read older rows; these replace it.
      this.settleNow()
      return
    }
    // Switch point: the order is a pure read of the rows' stamps, so any re-list re-sorts, as the window does.
    if (ORCA_SIDEBAR_INPUTS_IS_MAIN) {
      this.settleNow()
      return
    }
    const change = classifyCatalogListingChange(previous, this.listing)
    // Every row change bumps here, so the count can only move on a bump; no other write settles.
    const settled = change === 'rows' && this.noteSortInputChange(liveCount)
    const followsSave =
      change === 'sort-order' && ranksFollowPersistedOrder(this.sortBy, this.smartLatched)
    if (!settled && (repoChanged || followsSave)) {
      this.settleNow()
    }
  }

  /** Switch on: a saved metadata write no catalog event announced. */
  noteRowsWritten(): void {
    this.settleNow()
  }

  /** Activity alone never re-sorts; its sort-relevant causes arrive as their own changes. */
  noteActivityChange(): void {
    this.retentionPass()
  }

  /** The sort mode or the sleeping filter may have changed. */
  noteViewChange(): void {
    const previousSortBy = this.sortBy
    this.sortBy = this.inputs.sortBy()
    if (this.sortBy !== previousSortBy) {
      this.dispatchSettle({
        kind: 'write',
        change: null,
        settled: false,
        sortBy: this.sortBy,
        previousSortBy
      })
    }
    this.retentionPass()
  }

  dispose(): void {
    this.disposed = true
    this.sampleSeq += 1
    for (const key of [SETTLE_DEADLINE, CREATE_GRACE_DEADLINE, RETENTION_DEADLINE]) {
      this.clock.cancel(key)
    }
  }

  /** True once per session, for its first rows: they become the baseline, as the window's are. */
  private takeRowsSeed(liveCount: number): boolean {
    if (!this.seedRows) {
      return false
    }
    this.seedRows = false
    this.settleState = { ...this.settleState, liveCountAtLastBump: liveCount }
    return true
  }

  /** False until a window begins a session, and after dispose. */
  get running(): boolean {
    return this.sessionId !== null && !this.disposed
  }

  /** True when this event settled at once. */
  private dispatchSettle(event: SortSettleEvent): boolean {
    if (!this.running) {
      return false
    }
    const step = reduceSortSettle(this.settleState, event, Date.now())
    const deadline = step.state.deadline
    if (deadline !== this.settleState.deadline) {
      if (deadline === null) {
        this.clock.cancel(SETTLE_DEADLINE)
      } else {
        this.clock.schedule(SETTLE_DEADLINE, deadline, () =>
          this.dispatchSettle({ kind: 'deadline' })
        )
      }
    }
    this.settleState = step.state
    if (step.settle) {
      this.settleNow()
    }
    return step.settle
  }

  private settleNow(cause: SidebarSortSnapshot['cause'] = 'settle'): void {
    if (!this.running) {
      return
    }
    const seq = ++this.sampleSeq
    void this.inputs.readSortSample().then(
      (sample) => {
        if (seq === this.sampleSeq) {
          this.applySample(sample, cause)
        }
      },
      (error: unknown) => console.warn('[sidebar-temporal] could not read the rows to sort', error)
    )
  }

  private applySample(sample: SidebarSortSample, cause: SidebarSortSnapshot['cause']): void {
    const now = Date.now()
    const ranking = rankWorktreesForSort({
      worktrees: sample.worktrees.filter((worktree) => !worktree.isArchived),
      sortBy: this.sortBy,
      latched: this.smartLatched,
      repoMap: sample.repoMap,
      now,
      sources: sample.sources
    })
    this.smartLatched ||= ranking.detectedLiveSmartSignal
    this.epoch += 1
    this.sortSnapshot = {
      mode: this.sortBy,
      epoch: this.epoch,
      sampledAt: now,
      rankedIds: ranking.sorted.map(getWorktreeHostIdentity),
      smartLatched: this.smartLatched,
      cause
    }
    if (this.takeRowsSeed(countLiveRows(sample.worktrees))) {
      this.listing = indexCatalogListing(sample.worktrees)
    }
    this.identityById = new Map(
      sample.worktrees.map((worktree) => [worktree.id, getWorktreeHostIdentity(worktree)])
    )
    this.revision.bump()
    this.scheduleCreateGraceBoundary(ranking.sorted, now)
  }

  // Recent ranks a new row at its grace floor until the window closes; re-sort when it does.
  private scheduleCreateGraceBoundary(worktrees: readonly Worktree[], now: number): void {
    let next = Infinity
    // Stamps carry no create grace.
    const readsRecency =
      !ORCA_SIDEBAR_INPUTS_IS_MAIN &&
      (this.sortBy === 'recent' ||
        (this.sortBy === 'smart' && !ranksFollowPersistedOrder(this.sortBy, this.smartLatched)))
    if (readsRecency) {
      for (const { createdAt } of worktrees) {
        const closesAt = (createdAt ?? -Infinity) + CREATE_GRACE_MS
        if (closesAt > now && closesAt < next) {
          next = closesAt
        }
      }
    }
    if (next === Infinity) {
      this.clock.cancel(CREATE_GRACE_DEADLINE)
    } else {
      this.clock.schedule(CREATE_GRACE_DEADLINE, next, () => this.settleNow('create-grace'))
    }
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
      // The last sample's rows too, so an id that just went idle is not pruned out of its grace.
      candidateWorktreeIds: [...new Set([...candidates.ids, ...this.identityById.keys()])],
      isActive: candidates.isActive,
      isUnverifiableGap: candidates.isUnverifiableGap,
      nowMs: now
    })
    if (nextExpiryInMs === null) {
      this.clock.cancel(RETENTION_DEADLINE)
    } else {
      this.clock.schedule(RETENTION_DEADLINE, now + nextExpiryInMs, () => this.retentionPass())
    }
    // An id no sample has listed yet has no host to qualify it with, so it waits for one.
    const ids = [...retainedIds].flatMap((id) => this.identityById.get(id) ?? []).sort()
    const previous = this.retention?.retainedIds
    if (!previous || previous.length !== ids.length || previous.some((id, i) => id !== ids[i])) {
      this.retention = { retainedIds: ids, retentionDecidedAt: now }
      this.revision.bump()
    }
  }
}
