import { useCallback, useEffect, useMemo } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcSuccess } from '../transport/types'
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
import type { Worktree } from '../worktree/workspace-list-sections'
import type { HostScreenState } from './use-host-screen-state'

export function useHostViewSettings(args: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string | undefined
  state: HostScreenState
}) {
  const { client, connState, hostId, state } = args
  const {
    clientRef,
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

  // Apply a MobileViewState onto the individual states and the snapshot ref in one shot.
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

  // Apply the change locally, then patch the desktop's shared store (ui.set) so both apps stay in sync.
  const persistViewSettings = useCallback(
    (patch: Partial<MobileViewState>) => {
      const next: MobileViewState = { ...viewStateRef.current, ...patch }
      applyViewState(next)
      if (!client) {
        return
      }
      // Send only the touched fields: the host merges partial updates, so a stale
      // mirror can no longer revert sibling settings another client just changed
      // (STA-5781; supersedes the #8873 whole-payload special case).
      const payload: WorkspaceViewSettings = buildWorkspaceViewSettingsUpdate(patch, next)
      if (Object.keys(payload).length === 0) {
        return
      }
      void client.sendRequest('ui.set', payload).catch(() => {
        // Best-effort: view settings are a convenience preference.
      })
    },
    [client, applyViewState]
  )

  // Merge the desktop's shared view settings (PersistedUIState) onto local state so desktop changes appear here.
  const syncViewSettingsFromDesktop = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    const requestClient = client
    const requestHostId = hostId
    try {
      const response = await requestClient.sendRequest('ui.get')
      if (clientRef.current !== requestClient || hostId !== requestHostId || !response.ok) {
        return
      }
      const ui = ((response as RpcSuccess).result as { ui?: WorkspaceViewSettings }).ui
      if (!ui) {
        return
      }
      applyViewState(applyDesktopViewSettings(viewStateRef.current, ui))
    } catch {
      // Transient transport failure; retry on the next focus/connect.
    }
  }, [client, connState, hostId, applyViewState])

  const handleSortChange = useCallback(
    (value: MobileSortMode) => {
      persistViewSettings({ sortMode: value })
    },
    [persistViewSettings]
  )

  const toggleHideSleeping = useCallback(() => {
    persistViewSettings({ hideSleeping: !viewStateRef.current.hideSleeping })
  }, [persistViewSettings])

  const toggleHideDefaultBranch = useCallback(() => {
    persistViewSettings({ hideDefaultBranch: !viewStateRef.current.hideDefaultBranch })
  }, [persistViewSettings])

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

  const clearFilters = useCallback(() => {
    persistViewSettings({ hideSleeping: false, hideDefaultBranch: false, filterRepoIds: [] })
  }, [persistViewSettings])

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (filters.hideSleeping) {
      count++
    }
    if (filters.hideDefaultBranch) {
      count++
    }
    count += filters.filterRepoIds.size
    return count
  }, [filters])
  const selectedSortLabel =
    SORT_OPTIONS.find((option) => option.value === sortMode)?.label ?? 'Recent'

  const handleGroupChange = useCallback(
    (value: MobileGroupMode) => {
      persistViewSettings({ groupMode: value })
    },
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

export type HostViewSettings = ReturnType<typeof useHostViewSettings>
