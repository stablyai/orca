import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../store'

/**
 * Mirrors the sidebar/right-sidebar/filter preferences into the durable UI file.
 *
 * Why (#9002): activeView is deliberately kept off this debounced writer. It used to ride the
 * same 150ms save (#8265), so every top-level view switch scheduled a full durable-state write.
 */
export function usePersistedUIWriter(): void {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const activeView = useAppStore((s) => s.activeView)
  const ui = useAppStore(
    useShallow((s) => ({
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
      // Why: rides the same debounced save so dashboard auto-acks (which fire on focus/
      // visibility) and the in-memory ack cleanup paths in agent-status.ts (close/dismiss)
      // both flow to disk through map identity changes. Without persisting, agent rows that
      // survive restart come back bold even when the user had already visited them.
      acknowledgedAgentsByPaneKey: s.acknowledgedAgentsByPaneKey
    }))
  )

  useEffect(() => {
    if (!persistedUIReady) {
      return
    }

    const timer = window.setTimeout(() => {
      void window.api.ui.set({
        ...ui,
        showActiveOnly: false,
        hideSleepingWorkspaces: !ui.showSleepingWorkspaces,
        // Why: the store keeps this readonly for identity stability, but PersistedUI crosses to
        // main, which owns a mutable array — copy at the boundary rather than widening the wire type.
        filterRepoIds: [...ui.filterRepoIds]
      })
    }, 150)

    return () => window.clearTimeout(timer)
  }, [persistedUIReady, ui])

  // Why (#9002): activeView has its own tiny profile preference, so it can track
  // every switch without scheduling the multi-MB durable-state writer.
  useEffect(() => {
    if (!persistedUIReady) {
      return
    }
    void window.api.ui.set({ activeView })
  }, [activeView, persistedUIReady])
}
