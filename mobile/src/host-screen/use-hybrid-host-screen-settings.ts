import { useCallback, useEffect, useMemo } from 'react'
import { getMobileWorkspaceLineageGroupKey } from '../worktree/mobile-workspace-lineage'
import { WORKSPACE_SORT_OPTIONS as SORT_OPTIONS } from '../worktree/workspace-list-picker-options'
import {
  applyDesktopViewSettings,
  buildWorkspaceViewSettingsUpdate,
  type MobileGroupMode,
  type MobileSortMode,
  type MobileViewState,
  type WorkspaceViewSettings
} from '../worktree/workspace-view-settings'
import type { HostWorkspaceOperations } from '../worktree/host-workspace-operations'
import type { Worktree } from '../worktree/workspace-list-sections'
import type { HybridHostScreenState } from './use-hybrid-host-screen-state'

export function useHybridHostScreenSettings(args: {
  operations: HostWorkspaceOperations | null
  connState: string
  hostId: string | undefined
  state: HybridHostScreenState
}) {
  const { operations, connState, hostId, state } = args
  const {
    collapsedGroups,
    filters,
    groupMode,
    setCollapsedGroups,
    setFilters,
    setGroupMode,
    setSortMode,
    setWorkspaceStatuses,
    sortMode,
    viewStateRef,
    workspaceStatuses
  } = state
  useEffect(() => {
    viewStateRef.current = {
      groupMode,
      sortMode,
      hideSleeping: filters.hideSleeping,
      hideDefaultBranch: filters.hideDefaultBranch,
      alwaysShowDefaultBranch: filters.alwaysShowDefaultBranch !== false,
      filterRepoIds: [...filters.filterRepoIds],
      collapsedGroups: [...collapsedGroups],
      workspaceStatuses
    }
  }, [groupMode, sortMode, filters, collapsedGroups, workspaceStatuses])
  const applyViewState = useCallback((next: MobileViewState) => {
    viewStateRef.current = next
    setGroupMode(next.groupMode)
    setSortMode(next.sortMode)
    setWorkspaceStatuses(next.workspaceStatuses)
    setCollapsedGroups(new Set(next.collapsedGroups))
    setFilters({
      filterRepoIds: new Set(next.filterRepoIds),
      hideSleeping: next.hideSleeping,
      hideDefaultBranch: next.hideDefaultBranch,
      alwaysShowDefaultBranch: next.alwaysShowDefaultBranch
    })
  }, [])
  const persistViewSettings = useCallback(
    (patch: Partial<MobileViewState>) => {
      const next = { ...viewStateRef.current, ...patch }
      applyViewState(next)
      if (!operations) {
        return
      }
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next)
      if (Object.keys(payload).length > 0) {
        void operations.setViewSettings(payload).catch(() => {})
      }
    },
    [operations, applyViewState]
  )
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!operations || connState !== 'connected') {
      return
    }
    const request = operations,
      requestHostId = hostId
    try {
      const ui = await request.getViewSettings()
      if (state.workspaceOperationsRef.current !== request || hostId !== requestHostId || !ui) {
        return
      }
      applyViewState(applyDesktopViewSettings(viewStateRef.current, ui))
    } catch {}
  }, [operations, connState, hostId, applyViewState])
  const handleSortChange = useCallback(
    (value: MobileSortMode) => persistViewSettings({ sortMode: value }),
    [persistViewSettings]
  )
  const toggleHideSleeping = useCallback(
    () => persistViewSettings({ hideSleeping: !viewStateRef.current.hideSleeping }),
    [persistViewSettings]
  )
  const toggleHideDefaultBranch = useCallback(
    () => persistViewSettings({ hideDefaultBranch: !viewStateRef.current.hideDefaultBranch }),
    [persistViewSettings]
  )
  const toggleRepoFilter = useCallback(
    (repoId: string) => {
      const next = new Set(viewStateRef.current.filterRepoIds)
      if (next.has(repoId)) {
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      persistViewSettings({ filterRepoIds: [...next] })
    },
    [persistViewSettings]
  )
  const clearFilters = useCallback(
    () => persistViewSettings({ hideSleeping: false, hideDefaultBranch: false, filterRepoIds: [] }),
    [persistViewSettings]
  )
  const activeFilterCount = useMemo(
    () =>
      Number(filters.hideSleeping) + Number(filters.hideDefaultBranch) + filters.filterRepoIds.size,
    [filters]
  )
  const selectedSortLabel =
    SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? 'Recent'
  const handleGroupChange = useCallback(
    (value: MobileGroupMode) => persistViewSettings({ groupMode: value }),
    [persistViewSettings]
  )
  const toggleCollapsed = useCallback(
    (key: string) => {
      const next = new Set(viewStateRef.current.collapsedGroups)
      if (!next.delete(key)) {
        next.add(key)
      }
      persistViewSettings({ collapsedGroups: [...next] })
    },
    [persistViewSettings]
  )
  const toggleWorktreeLineage = useCallback(
    (item: Worktree) => toggleCollapsed(getMobileWorkspaceLineageGroupKey(item)),
    [toggleCollapsed]
  )
  return {
    activeFilterCount,
    clearFilters,
    handleGroupChange,
    handleSortChange,
    selectedSortLabel,
    syncViewSettingsFromDesktop,
    toggleCollapsed,
    toggleHideDefaultBranch,
    toggleHideSleeping,
    toggleRepoFilter,
    toggleWorktreeLineage
  }
}
