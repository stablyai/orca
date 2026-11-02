import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import { isAgentStatusFresh } from '../../../shared/agent-status-freshness'
import { isSmartSortRelevantAgentChange } from '../../../shared/sidebar-list/smart-sort-agent-change'
import { resolveAgentStatusLiveEntryStateHistory } from '../../../shared/agent-status-live-entry-state-history'
import type { AgentStatusStoreView } from './workspace-activity-facts-producer'

/**
 * The hook store's rows as the entries Smart scores, one per pane. The store keeps no history,
 * so state switches are recorded here, as the window records them from the same rows.
 */
export class SmartSortAgentEntries {
  private readonly entries = new Map<string, AgentStatusEntry>()
  private store: AgentStatusStoreView | null = null

  attach(store: AgentStatusStoreView, onChange: () => void): () => void {
    this.store = store
    for (const row of store.getStatusSnapshot()) {
      this.refreshPane(row.paneKey)
    }
    const unsubscribe = store.subscribeStatusRowMutations(({ before, after }) => {
      let relevant = false
      for (const paneKey of new Set([before?.paneKey, after?.paneKey])) {
        if (paneKey) {
          relevant = this.refreshPane(paneKey) || relevant
        }
      }
      if (relevant) {
        onChange()
      }
    })
    return () => {
      unsubscribe()
      this.store = null
      this.entries.clear()
    }
  }

  byPaneKey(): Record<string, AgentStatusEntry> {
    return Object.fromEntries(this.entries)
  }

  /** True when the change can move the pane in the Smart order, as the window decides. */
  private refreshPane(paneKey: string): boolean {
    // The window applies a pane's rows in arrival order, so the newest is the one it holds.
    const rows = (this.store?.getStatusSnapshotForPane(paneKey) ?? []).filter(
      (row) => !row.providerSessionOnly
    )
    const latest = rows.reduce<AgentStatusIpcPayload | null>(
      (newest, row) => (newest && newest.receivedAt >= row.receivedAt ? newest : row),
      null
    )
    const existing = this.entries.get(paneKey)
    if (!latest) {
      this.entries.delete(paneKey)
      return (
        existing !== undefined &&
        isAgentStatusFresh(existing, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
      )
    }
    const { history, stateObservedAt } = resolveAgentStatusLiveEntryStateHistory(
      existing,
      latest,
      latest.receivedAt
    )
    const entry: AgentStatusEntry = {
      state: latest.state,
      ...(latest.workingMode !== undefined ? { workingMode: latest.workingMode } : {}),
      prompt: latest.prompt,
      updatedAt: latest.receivedAt,
      ...(latest.evidenceObservedAt !== undefined
        ? { evidenceObservedAt: latest.evidenceObservedAt }
        : {}),
      ...(latest.structuredHost === 'owned' ? { structuredHostOwned: true as const } : {}),
      stateStartedAt: latest.stateStartedAt,
      stateObservedAt,
      ...(latest.turnStartedAt !== undefined ? { turnStartedAt: latest.turnStartedAt } : {}),
      agentType: latest.agentType,
      paneKey,
      ...(latest.worktreeId ? { worktreeId: latest.worktreeId } : {}),
      ...(latest.tabId ? { tabId: latest.tabId } : {}),
      stateHistory: history,
      ...(latest.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
      interrupted: latest.interrupted,
      sessionBoundary: latest.sessionBoundary,
      ...(latest.mainAgent ? { mainAgent: latest.mainAgent } : {})
    }
    this.entries.set(paneKey, entry)
    // The window also re-sorts on a Command Code prompt; that turn moves stateStartedAt here.
    return isSmartSortRelevantAgentChange(existing, entry, latest.receivedAt)
  }
}
