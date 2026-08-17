// View state (group / sort / filters / collapsed groups) for the merged Projects
// home, persisted locally. Kept out of the screen so the screen stays a renderer.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DEFAULT_PROJECTS_HOME_VIEW_SETTINGS,
  loadProjectsHomeViewSettings,
  saveProjectsHomeViewSettings,
  type ProjectsHomeViewSettings
} from '../storage/projects-home-view-settings'
import type { FilterState } from './workspace-list-types'
import {
  retainRepresentedExecutionHostIds,
  type ExecutionHostFilterOption
} from './merged-desktop-workspaces'
import type { MobileGroupMode, MobileSortMode } from './workspace-view-settings'

export type ProjectsHomeViewState = {
  settings: ProjectsHomeViewSettings
  filters: FilterState
  activeFilterCount: number
  collapsedGroups: ReadonlySet<string>
  setGroupMode: (mode: MobileGroupMode) => void
  setSortMode: (mode: MobileSortMode) => void
  toggleHideSleeping: () => void
  toggleHideDefaultBranch: () => void
  toggleExecutionHost: (hostId: string) => void
  pruneExecutionHosts: (options: readonly ExecutionHostFilterOption[]) => void
  clearFilters: () => void
  toggleCollapsedGroup: (key: string) => void
}

export function useProjectsHomeViewState(): ProjectsHomeViewState {
  const [settings, setSettings] = useState<ProjectsHomeViewSettings>(
    DEFAULT_PROJECTS_HOME_VIEW_SETTINGS
  )
  // Why: collapsed groups are view-session state, not a preference — a group the
  // user folded to scan one repo should not still be folded next launch.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    let cancelled = false
    void loadProjectsHomeViewSettings().then((loaded) => {
      if (!cancelled) {
        setSettings(loaded)
        setHydrated(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(
    (patch: Partial<ProjectsHomeViewSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch }
        // Why the guard: writing before the load resolves would persist the
        // defaults over settings still in flight and silently reset the user.
        if (hydrated) {
          void saveProjectsHomeViewSettings(next)
        }
        return next
      })
    },
    [hydrated]
  )

  const filters = useMemo<FilterState>(
    () => ({
      filterRepoIds: new Set(),
      hideSleeping: settings.hideSleeping,
      hideDefaultBranch: settings.hideDefaultBranch,
      alwaysShowDefaultBranch: true,
      filterExecutionHostIds: new Set(settings.executionHostIds)
    }),
    [settings]
  )

  const activeFilterCount =
    (settings.hideSleeping ? 1 : 0) +
    (settings.hideDefaultBranch ? 1 : 0) +
    settings.executionHostIds.length

  const toggleExecutionHost = useCallback(
    (hostId: string) => {
      setSettings((prev) => {
        const selected = new Set(prev.executionHostIds)
        if (!selected.delete(hostId)) {
          selected.add(hostId)
        }
        const next = { ...prev, executionHostIds: [...selected] }
        if (hydrated) {
          void saveProjectsHomeViewSettings(next)
        }
        return next
      })
    },
    [hydrated]
  )

  const pruneExecutionHosts = useCallback(
    (options: readonly ExecutionHostFilterOption[]) => {
      setSettings((prev) => {
        const retained = [
          ...retainRepresentedExecutionHostIds(new Set(prev.executionHostIds), options)
        ]
        if (
          retained.length === prev.executionHostIds.length &&
          retained.every((id, index) => id === prev.executionHostIds[index])
        ) {
          return prev
        }
        const next = { ...prev, executionHostIds: retained }
        if (hydrated) {
          void saveProjectsHomeViewSettings(next)
        }
        return next
      })
    },
    [hydrated]
  )

  const toggleCollapsedGroup = useCallback((key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) {
        next.add(key)
      }
      return next
    })
  }, [])

  return {
    settings,
    filters,
    activeFilterCount,
    collapsedGroups,
    setGroupMode: useCallback((groupMode) => update({ groupMode }), [update]),
    setSortMode: useCallback((sortMode) => update({ sortMode }), [update]),
    toggleHideSleeping: useCallback(
      () => update({ hideSleeping: !settings.hideSleeping }),
      [update, settings.hideSleeping]
    ),
    toggleHideDefaultBranch: useCallback(
      () => update({ hideDefaultBranch: !settings.hideDefaultBranch }),
      [update, settings.hideDefaultBranch]
    ),
    toggleExecutionHost,
    pruneExecutionHosts,
    clearFilters: useCallback(
      () => update({ hideSleeping: false, hideDefaultBranch: false, executionHostIds: [] }),
      [update]
    ),
    toggleCollapsedGroup
  }
}
