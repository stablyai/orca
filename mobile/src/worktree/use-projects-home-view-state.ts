// View state (group / sort / filters / collapsed groups) for the merged Projects
// home, persisted locally. Kept out of the screen so the screen stays a renderer.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  const settingsRef = useRef(settings)
  const hydratedRef = useRef(false)
  const dirtyKeysRef = useRef(new Set<keyof ProjectsHomeViewSettings>())
  // Why: collapsed groups are view-session state, not a preference — a group the
  // user folded to scan one repo should not still be folded next launch.
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    void loadProjectsHomeViewSettings().then((loaded) => {
      if (!cancelled) {
        const current = settingsRef.current
        const dirty = dirtyKeysRef.current
        const merged = {
          groupMode: dirty.has('groupMode') ? current.groupMode : loaded.groupMode,
          sortMode: dirty.has('sortMode') ? current.sortMode : loaded.sortMode,
          hideSleeping: dirty.has('hideSleeping') ? current.hideSleeping : loaded.hideSleeping,
          hideDefaultBranch: dirty.has('hideDefaultBranch')
            ? current.hideDefaultBranch
            : loaded.hideDefaultBranch,
          executionHostIds: dirty.has('executionHostIds')
            ? current.executionHostIds
            : loaded.executionHostIds
        }
        settingsRef.current = merged
        hydratedRef.current = true
        setSettings(merged)
        if (dirty.size > 0) {
          void saveProjectsHomeViewSettings(merged)
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const commitSettings = useCallback(
    (next: ProjectsHomeViewSettings, changedKeys: readonly (keyof ProjectsHomeViewSettings)[]) => {
      settingsRef.current = next
      setSettings(next)
      if (hydratedRef.current) {
        void saveProjectsHomeViewSettings(next)
      } else {
        changedKeys.forEach((key) => dirtyKeysRef.current.add(key))
      }
    },
    []
  )

  const update = useCallback(
    <Key extends keyof ProjectsHomeViewSettings>(patch: Pick<ProjectsHomeViewSettings, Key>) => {
      commitSettings({ ...settingsRef.current, ...patch }, Object.keys(patch) as Key[])
    },
    [commitSettings]
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
      const selected = new Set(settingsRef.current.executionHostIds)
      if (!selected.delete(hostId)) {
        selected.add(hostId)
      }
      update({ executionHostIds: [...selected] })
    },
    [update]
  )

  const pruneExecutionHosts = useCallback(
    (options: readonly ExecutionHostFilterOption[]) => {
      const previous = settingsRef.current.executionHostIds
      const retained = [...retainRepresentedExecutionHostIds(new Set(previous), options)]
      if (
        retained.length !== previous.length ||
        retained.some((id, index) => id !== previous[index])
      ) {
        update({ executionHostIds: retained })
      }
    },
    [update]
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
      () => update({ hideSleeping: !settingsRef.current.hideSleeping }),
      [update]
    ),
    toggleHideDefaultBranch: useCallback(
      () => update({ hideDefaultBranch: !settingsRef.current.hideDefaultBranch }),
      [update]
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
