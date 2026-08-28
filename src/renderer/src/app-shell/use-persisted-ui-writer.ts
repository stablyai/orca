import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'
import {
  diffPersistedUIWriteFields,
  persistedUIWriteFieldsToWireUpdate,
  type PersistedUIWriteBaseline
} from '../store/slices/persisted-ui-write-baseline'

/**
 * Mirrors the sidebar/right-sidebar/filter preferences into the durable UI file.
 *
 * Why field-level diffs (STA-5781): the durable UI state is shared with mobile/web
 * clients, which edit it concurrently. Writing the whole snapshot let this client's
 * stale mirror overwrite fields another client had just changed. The writer now
 * diffs the mirror against the last state hydrated from main and persists only the
 * fields this client changed itself; main merges partial updates field-by-field.
 *
 * Why (#9002): activeView is deliberately kept off this debounced writer. It used to ride the
 * same 150ms save (#8265), so every top-level view switch scheduled a full durable-state write.
 */
export function usePersistedUIWriter(): void {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeView = useAppStore((s) => s.activeView)
  const hydratedBaseline = useAppStore((s) => s.persistedUIWriteBaseline)
  const markPersistedUIWriteFlushed = useAppStore((s) => s.markPersistedUIWriteFlushed)
  const ui = useAppStore(
    useShallow(
      (s): PersistedUIWriteBaseline => ({
        sidebarWidth: s.sidebarWidth,
        rightSidebarOpen: s.rightSidebarOpen,
        rightSidebarTab: s.rightSidebarTab,
        rightSidebarExplorerView: s.rightSidebarExplorerView,
        rightSidebarWidth: s.rightSidebarWidth,
        markdownTocPanelWidth: s.markdownTocPanelWidth,
        combinedDiffFileTreeWidth: s.combinedDiffFileTreeWidth,
        groupBy: s.groupBy,
        sortBy: s.sortBy,
        projectOrderBy: s.projectOrderBy,
        showSleepingWorkspaces: s.showSleepingWorkspaces,
        hideDefaultBranchWorkspace: s.hideDefaultBranchWorkspace,
        hideAutomationGeneratedWorkspaces: s.hideAutomationGeneratedWorkspaces,
        hideCliCreatedWorkspaces: s.hideCliCreatedWorkspaces,
        hideDetachedHeadWorkspaces: s.hideDetachedHeadWorkspaces,
        hideWorkspacesFromOtherDevices: s.hideWorkspacesFromOtherDevices,
        alwaysShowDefaultBranchWorkspace: s.alwaysShowDefaultBranchWorkspace,
        showDotfilesByWorktree: s.showDotfilesByWorktree,
        filterRepoIds: s.filterRepoIds,
        // Why: dashboard auto-acks (fire on focus/visibility) and the in-memory ack cleanup
        // paths in agent-status.ts (close/dismiss) flow to disk through map identity changes.
        // Without persisting, agent rows that survive restart come back bold even when the
        // user had already visited them.
        acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey
      })
    )
  )
  useEffect(() => {
    // The baseline holds the values this client last saw persisted (newest
    // hydration from main, overlaid with this client's flushed writes); fields
    // equal to it are never written, so remote changes are never echoed back.
    if (!persistedUIReady || !hydratedBaseline) {
      return
    }
    const changed = diffPersistedUIWriteFields(ui, hydratedBaseline)
    if (Object.keys(changed).length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      // Fold into the baseline before the async send so this effect's re-run
      // (and the sync-hydration pending-edit overlay) both see the flush.
      markPersistedUIWriteFlushed(changed)
      void window.api.ui.set(persistedUIWriteFieldsToWireUpdate(changed))
    }, 150)

    return () => window.clearTimeout(timer)
  }, [persistedUIReady, hydratedBaseline, ui, markPersistedUIWriteFlushed])

  // Why (#9002): activeView has its own tiny profile preference, so it can track
  // every switch without scheduling the multi-MB durable-state writer.
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    void window.api.ui.set({ activeView })
  }, [activeView, persistedUIReady])
}
