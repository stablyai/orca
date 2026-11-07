import { newerPersonalProjectOrder } from '../../../src/shared/personal-project-order'
// Sync phone view settings through the shared ui.get/ui.set store so edits converge across clients.

import type { WorkspaceStatusDefinition } from '../../../src/shared/worktree/types'
import {
  withDefaultWorkspaceStatuses,
  DEFAULT_WORKSPACE_STATUSES
} from '../../../src/shared/workspace-statuses'
import {
  NO_WORKSPACE_ROW_FILTERS,
  WORKSPACE_ROW_FILTER_KEYS,
  WORKSPACE_ROW_FILTER_UI_FIELDS
} from '../../../src/shared/workspace-view/workspace-row-filters'
import { resolveVisibleWorkspaceHostIds } from '../../../src/shared/workspace-view/workspace-host-visibility'
import type { PersistedUIState } from '../../../src/shared/persisted-ui-state-types'
import type { WORKSPACE_VIEW_UI_FIELDS } from '../../../src/shared/workspace-view/workspace-view-ui-fields'
import type { FilterState } from './workspace-list-types'
import type {
  AgentActivityDisplayMode,
  ProjectOrderBy,
  WorktreeCardProperty
} from '../../../src/shared/ui-chrome-types'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../src/shared/worktree/card-properties'
import {
  WORKSPACE_GROUP_BY_CHOICES,
  WORKSPACE_SORT_BY_CHOICES
} from '../../../src/shared/workspace-view/workspace-view-options'

export type WorkspaceViewSettings = {
  [
    Key in keyof FilterState as (typeof WORKSPACE_ROW_FILTER_UI_FIELDS)[Key]
  ]?: Key extends 'filterRepoIds'
    ? string[]
    : Key extends 'visibleHostIds'
      ? string[] | null
      : FilterState[Key]
} & Partial<
  Pick<
    PersistedUIState,
    | (typeof WORKSPACE_VIEW_UI_FIELDS)[number]
    // Written with the card properties only: whether they are a Card layout preset.
    | '_worktreeCardModeDefaulted'
    | 'personalProjectOrder'
  >
>

export type MobileViewState = {
  groupBy: PersistedUIState['groupBy']
  sortBy: PersistedUIState['sortBy']
  filters: FilterState
  collapsedGroups: readonly string[]
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  /** Null until the desktop's value is read; the served project list's order stands in. */
  personalProjectOrder?: PersistedUIState['personalProjectOrder']
  projectOrderBy: ProjectOrderBy | null
  /** May hold a property a newer desktop added; it is carried back unchanged. */
  worktreeCardProperties: readonly WorktreeCardProperty[]
  agentActivityDisplayMode: AgentActivityDisplayMode
  // Null until ui.get arrives, preventing new-host other-client marks from hiding rows before their filter value.
  // Older desktops mark only rows their own filter hides.
  sharesOtherClientFilter: boolean | null
  /** Desktop settings, not UI state: read with settings.get; Card layout writes the first. */
  compactWorktreeCards: boolean
  newCardStyle: boolean
}

export const INITIAL_MOBILE_VIEW: MobileViewState = {
  groupBy: 'repo',
  sortBy: 'recent',
  filters: NO_WORKSPACE_ROW_FILTERS,
  collapsedGroups: [],
  workspaceStatuses: DEFAULT_WORKSPACE_STATUSES,
  projectOrderBy: null,
  worktreeCardProperties: DEFAULT_WORKTREE_CARD_PROPERTIES,
  agentActivityDisplayMode: 'compact',
  sharesOtherClientFilter: null,
  compactWorktreeCards: false,
  newCardStyle: false
}

// Patch only touched fields; compactWorktreeCards is written as a setting after host acceptance.
export type MobileViewPatch = Partial<
  Omit<MobileViewState, 'filters' | 'sharesOtherClientFilter' | 'newCardStyle'>
> & {
  filters?: Partial<FilterState>
}

const GROUP_BY_VALUES: readonly string[] = WORKSPACE_GROUP_BY_CHOICES.map((choice) => choice.id)
const SORT_BY_VALUES: readonly string[] = WORKSPACE_SORT_BY_CHOICES.map((choice) => choice.id)

function isGroupBy(value: string | undefined): value is PersistedUIState['groupBy'] {
  return value !== undefined && GROUP_BY_VALUES.includes(value)
}

function isSortBy(value: string | undefined): value is PersistedUIState['sortBy'] {
  return value !== undefined && SORT_BY_VALUES.includes(value)
}

export function rowFiltersForView(view: MobileViewState): FilterState {
  return view.sharesOtherClientFilter === false
    ? { ...view.filters, hideWorkspacesFromOtherDevices: true }
    : view.filters
}

// Send only edited fields so stale mirrors cannot revert concurrent edits from other clients (STA-5781).
export function buildWorkspaceViewSettingsUpdate(
  patch: MobileViewPatch,
  next: MobileViewState,
  options: { cardLayoutPreset?: boolean } = {}
): WorkspaceViewSettings {
  const update: WorkspaceViewSettings = {}
  if ('groupBy' in patch) {
    update.groupBy = next.groupBy
  }
  if ('sortBy' in patch) {
    update.sortBy = next.sortBy
  }
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    if (patch.filters && key in patch.filters) {
      const value = next.filters[key]
      Object.assign(update, {
        [WORKSPACE_ROW_FILTER_UI_FIELDS[key]]: Array.isArray(value) ? [...value] : value
      })
    }
  }
  const hostIds = next.filters.visibleHostIds
  // An older desktop reads its legacy scope when the list is null, so "all" must be written too.
  if (patch.filters && 'visibleHostIds' in patch.filters && (hostIds?.length ?? 1) === 1) {
    update.workspaceHostScope = hostIds?.[0] ?? 'all'
  }
  if ('projectOrderBy' in patch && next.projectOrderBy) {
    update.projectOrderBy = next.projectOrderBy
  }
  if ('worktreeCardProperties' in patch) {
    update.worktreeCardProperties = [...next.worktreeCardProperties]
    // As the desktop's own edit: a hand-picked set is no longer a Card layout preset.
    update._worktreeCardModeDefaulted = options.cardLayoutPreset === true
  }
  if ('agentActivityDisplayMode' in patch) {
    update.agentActivityDisplayMode = next.agentActivityDisplayMode
  }
  if ('collapsedGroups' in patch) {
    update.collapsedGroups = [...next.collapsedGroups]
  }
  if ('workspaceStatuses' in patch) {
    update.workspaceStatuses = [...next.workspaceStatuses]
  }
  return update
}

// Preserve local values for fields absent from partial desktop state.
export function applyDesktopViewSettings(
  current: MobileViewState,
  settings: WorkspaceViewSettings
): MobileViewState {
  // Keep renderable status groups while desktop settings hydrate with an empty catalog.
  const workspaceStatuses = settings.workspaceStatuses
    ? withDefaultWorkspaceStatuses(settings.workspaceStatuses)
    : current.workspaceStatuses
  const filters: FilterState = { ...current.filters }
  for (const key of WORKSPACE_ROW_FILTER_KEYS) {
    const value = settings[WORKSPACE_ROW_FILTER_UI_FIELDS[key]]
    if (key !== 'visibleHostIds' && value !== undefined) {
      Object.assign(filters, { [key]: value })
    }
  }
  // As the desktop reads it: with no list saved, its legacy single-host scope still narrows.
  if (settings.visibleWorkspaceHostIds !== undefined || settings.workspaceHostScope !== undefined) {
    filters.visibleHostIds = resolveVisibleWorkspaceHostIds(
      settings.visibleWorkspaceHostIds,
      settings.workspaceHostScope
    )
  }
  const personalProjectOrder = newerPersonalProjectOrder(
    current.personalProjectOrder,
    settings.personalProjectOrder
  )
  return {
    groupBy: isGroupBy(settings.groupBy) ? settings.groupBy : current.groupBy,
    sortBy: isSortBy(settings.sortBy) ? settings.sortBy : current.sortBy,
    filters,
    collapsedGroups: settings.collapsedGroups ?? current.collapsedGroups,
    workspaceStatuses,
    ...(personalProjectOrder ? { personalProjectOrder } : {}),
    projectOrderBy: settings.projectOrderBy ?? current.projectOrderBy,
    worktreeCardProperties: settings.worktreeCardProperties ?? current.worktreeCardProperties,
    agentActivityDisplayMode: settings.agentActivityDisplayMode ?? current.agentActivityDisplayMode,
    // Each ui.get is the desktop's whole state, so the field's absence means it keeps the filter.
    sharesOtherClientFilter: settings.hideWorkspacesFromOtherDevices !== undefined,
    compactWorktreeCards: current.compactWorktreeCards,
    newCardStyle: current.newCardStyle
  }
}
