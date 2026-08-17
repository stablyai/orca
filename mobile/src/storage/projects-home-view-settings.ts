// Group/sort/filter state for the merged Projects home list.
//
// Why local instead of the desktop's ui.get/ui.set like the per-host list: this
// list spans every paired desktop, so there is no single desktop whose persisted
// UI state it could belong to. Writing to all of them would let a phone-side
// filter change mutate every paired machine.

import AsyncStorage from '@react-native-async-storage/async-storage'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import type { MobileGroupMode, MobileSortMode } from '../worktree/workspace-view-settings'

const STORAGE_KEY = 'orca:projectsHome:view'

export type ProjectsHomeViewSettings = {
  groupMode: MobileGroupMode
  sortMode: MobileSortMode
  hideSleeping: boolean
  hideDefaultBranch: boolean
  executionHostIds: string[]
}

export const DEFAULT_PROJECTS_HOME_VIEW_SETTINGS: ProjectsHomeViewSettings = {
  groupMode: 'repo',
  sortMode: 'recent',
  hideSleeping: false,
  hideDefaultBranch: false,
  executionHostIds: []
}

const GROUP_MODES: readonly MobileGroupMode[] = ['none', 'workspaceStatus', 'repo', 'prStatus']
const SORT_MODES: readonly MobileSortMode[] = ['smart', 'name', 'recent', 'repo', 'manual']

function isPersistedFilterId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    return false
  }
  if (normalizeExecutionHostId(value)) {
    return true
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      parsed[0].length > 0 &&
      parsed[0].length <= 512 &&
      (parsed[1] === null ||
        (typeof parsed[1] === 'string' && normalizeExecutionHostId(parsed[1]) !== null))
    )
  } catch {
    return false
  }
}

function persistedFilterIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter(isPersistedFilterId))]
}

/**
 * Reads persisted settings, falling back per field. A partial or corrupt record
 * must still open a usable list, so anything unrecognised takes the default
 * rather than failing the whole read.
 */
export function parseProjectsHomeViewSettings(raw: string | null): ProjectsHomeViewSettings {
  if (!raw) {
    return DEFAULT_PROJECTS_HOME_VIEW_SETTINGS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_PROJECTS_HOME_VIEW_SETTINGS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_PROJECTS_HOME_VIEW_SETTINGS
  }
  const record = parsed as Partial<Record<keyof ProjectsHomeViewSettings, unknown>>
  return {
    groupMode: GROUP_MODES.includes(record.groupMode as MobileGroupMode)
      ? (record.groupMode as MobileGroupMode)
      : DEFAULT_PROJECTS_HOME_VIEW_SETTINGS.groupMode,
    sortMode: SORT_MODES.includes(record.sortMode as MobileSortMode)
      ? (record.sortMode as MobileSortMode)
      : DEFAULT_PROJECTS_HOME_VIEW_SETTINGS.sortMode,
    hideSleeping: record.hideSleeping === true,
    hideDefaultBranch: record.hideDefaultBranch === true,
    executionHostIds: persistedFilterIds(record.executionHostIds)
  }
}

export async function loadProjectsHomeViewSettings(): Promise<ProjectsHomeViewSettings> {
  try {
    return parseProjectsHomeViewSettings(await AsyncStorage.getItem(STORAGE_KEY))
  } catch {
    return DEFAULT_PROJECTS_HOME_VIEW_SETTINGS
  }
}

export async function saveProjectsHomeViewSettings(
  settings: ProjectsHomeViewSettings
): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings)).catch(() => undefined)
}
