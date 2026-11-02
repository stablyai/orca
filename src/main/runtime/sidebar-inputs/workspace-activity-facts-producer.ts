import { ProducerRevision } from './producer-revision'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import { agentStatusEvidenceObservedAt } from '../../../shared/agent-status-freshness'
import { resolveAgentStatusWorktreeId } from '../../../shared/agent-status-worktree-attribution'
import {
  IDLE_WORKSPACE_ACTIVITY,
  isIdleWorkspaceActivity,
  liveAgentStatusOf,
  strongerLiveAgentStatus,
  workspaceActivityFactsEqual,
  type LiveAgentWorktreeStatus,
  type WorkspaceActivityFacts,
  type WorkspaceActivityFactsSnapshot
} from '../../../shared/sidebar-list/workspace-activity-facts'
import type { AgentHookServer } from '../../agent-hooks/server'
import type { SidebarClock } from './sidebar-clock'

export type WorkspaceSurfaceActivity = Omit<WorkspaceActivityFacts, 'agent'>

/** The hook server's store: one snapshot to seed from, then per-row change taps. */
export type AgentStatusStoreView = Pick<
  AgentHookServer,
  | 'getStatusSnapshot'
  | 'getStatusSnapshotForPane'
  | 'subscribeStatusRowMutations'
  | 'subscribeStatusFreshness'
>

const AGENT_FRESHNESS_DEADLINE = 'agent-freshness'

type AgentPane = { worktreeId: string; status: LiveAgentWorktreeStatus; staleAt: number }

/**
 * Per-workspace activity facts the sidebar builder reads, kept current one workspace at a time.
 * Surfaces are re-read when the runtime publishes a workspace; agent rows follow the hook server's
 * per-row mutations, so a status ping re-derives one pane and never re-reads surfaces.
 */
export class WorkspaceActivityFactsProducer {
  private readonly facts = new Map<string, WorkspaceActivityFacts>()
  private readonly agentPanes = new Map<string, AgentPane>()
  private readonly agentPanesByWorktree = new Map<string, Map<string, AgentPane>>()
  private agentStore: AgentStatusStoreView | null = null
  readonly revision = new ProducerRevision()
  private expiryAt = Infinity

  constructor(
    private readonly deps: {
      readSurfaces: (worktreeId: string) => WorkspaceSurfaceActivity
      resolveTabWorktreeId: (tabId: string) => string | undefined
      clock: SidebarClock
    }
  ) {}

  snapshot(): WorkspaceActivityFactsSnapshot {
    return { revision: this.revision.value, facts: Object.fromEntries(this.facts) }
  }

  /** Re-reads the workspace's surfaces; the runtime calls this per publication. */
  refreshWorkspace(worktreeId: string): void {
    this.publish(worktreeId, this.deps.readSurfaces(worktreeId))
  }

  attachAgentStatusStore(store: AgentStatusStoreView): () => void {
    this.agentStore = store
    this.resyncAgentPanes()
    const unsubscribeMutations = store.subscribeStatusRowMutations(({ before, after }) => {
      if (before) {
        this.refreshAgentPane(before.paneKey)
      }
      if (after && after.paneKey !== before?.paneKey) {
        this.refreshAgentPane(after.paneKey)
      }
    })
    // Duplicate evidence renews a row's lease without a semantic mutation.
    const unsubscribeFreshness = store.subscribeStatusFreshness(({ paneKey }) =>
      this.refreshAgentPane(paneKey)
    )
    return () => {
      unsubscribeMutations()
      unsubscribeFreshness()
      this.agentStore = null
      this.clearExpiryTimer()
    }
  }

  /** Re-derives every pane; attribution reads the runtime's tabs, which a graph sync replaces. */
  resyncAgentPanes(): void {
    const paneKeys = new Set(this.agentPanes.keys())
    for (const row of this.agentStore?.getStatusSnapshot() ?? []) {
      paneKeys.add(row.paneKey)
    }
    for (const paneKey of paneKeys) {
      this.refreshAgentPane(paneKey)
    }
  }

  private refreshAgentPane(paneKey: string): void {
    const previous = this.agentPanes.get(paneKey)
    const next = this.toAgentPane(this.agentStore?.getStatusSnapshotForPane(paneKey) ?? [])
    if (previous) {
      this.agentPanes.delete(paneKey)
      const panes = this.agentPanesByWorktree.get(previous.worktreeId)
      if (panes?.delete(paneKey) && panes.size === 0) {
        this.agentPanesByWorktree.delete(previous.worktreeId)
      }
    }
    if (next) {
      this.agentPanes.set(paneKey, next)
      const panes = this.agentPanesByWorktree.get(next.worktreeId) ?? new Map<string, AgentPane>()
      this.agentPanesByWorktree.set(next.worktreeId, panes.set(paneKey, next))
      this.armExpiry(next.staleAt)
    }
    if (previous) {
      this.refreshAgent(previous.worktreeId)
    }
    if (next && next.worktreeId !== previous?.worktreeId) {
      this.refreshAgent(next.worktreeId)
    }
  }

  // A pane's rows (one per canonical subject) fold into its first row's workspace.
  private toAgentPane(rows: readonly AgentStatusIpcPayload[]): AgentPane | null {
    const now = Date.now()
    const live: AgentPane[] = []
    for (const row of rows) {
      const entry = {
        state: row.state,
        workingMode: row.workingMode,
        updatedAt: row.receivedAt,
        evidenceObservedAt: row.evidenceObservedAt,
        restoredUnconfirmed: row.restoredUnconfirmed,
        ...(row.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {})
      }
      // The window's own attribution rule, over this runtime's tabs.
      const worktreeId = resolveAgentStatusWorktreeId(row, { get: this.deps.resolveTabWorktreeId })
      if (row.providerSessionOnly || !worktreeId || !isFreshNonDoneAgentStatus(entry, now)) {
        continue
      }
      live.push({
        worktreeId,
        status: liveAgentStatusOf(entry),
        staleAt: entry.structuredHostOwned
          ? Infinity
          : agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS + 1
      })
    }
    if (live.length === 0) {
      return null
    }
    return {
      worktreeId: live[0].worktreeId,
      status: live.reduce<LiveAgentWorktreeStatus>(
        (status, pane) => strongerLiveAgentStatus(status, pane.status),
        live[0].status
      ),
      staleAt: Math.min(...live.map((pane) => pane.staleAt))
    }
  }

  // An agent change keeps the surfaces last read; absent facts mean idle surfaces.
  private refreshAgent(worktreeId: string): void {
    this.publish(worktreeId, this.facts.get(worktreeId) ?? IDLE_WORKSPACE_ACTIVITY)
  }

  private publish(worktreeId: string, surfaces: WorkspaceSurfaceActivity): void {
    let agent: LiveAgentWorktreeStatus | null = null
    for (const pane of this.agentPanesByWorktree.get(worktreeId)?.values() ?? []) {
      agent = strongerLiveAgentStatus(agent, pane.status)
    }
    const next: WorkspaceActivityFacts = {
      terminal: surfaces.terminal,
      browser: surfaces.browser,
      structuredChat: surfaces.structuredChat,
      agent
    }
    const previous = this.facts.get(worktreeId)
    if (isIdleWorkspaceActivity(next)) {
      if (!previous) {
        return
      }
      this.facts.delete(worktreeId)
    } else {
      if (previous && workspaceActivityFactsEqual(previous, next)) {
        return
      }
      this.facts.set(worktreeId, next)
    }
    this.revision.bump()
  }

  // One deadline for the earliest lease; a renewed lease only moves later, so an early fire re-arms.
  private armExpiry(staleAt: number): void {
    if (staleAt >= this.expiryAt) {
      return
    }
    this.expiryAt = staleAt
    this.deps.clock.schedule(AGENT_FRESHNESS_DEADLINE, staleAt, () => this.expireAgentPanes())
  }

  private expireAgentPanes(): void {
    this.expiryAt = Infinity
    const now = Date.now()
    const stale: string[] = []
    for (const [paneKey, pane] of this.agentPanes) {
      if (pane.staleAt <= now) {
        stale.push(paneKey)
      } else {
        this.armExpiry(pane.staleAt)
      }
    }
    // Re-derived, not dropped: another of the pane's rows may still be fresh.
    for (const paneKey of stale) {
      this.refreshAgentPane(paneKey)
    }
  }

  private clearExpiryTimer(): void {
    this.deps.clock.cancel(AGENT_FRESHNESS_DEADLINE)
    this.expiryAt = Infinity
  }
}
