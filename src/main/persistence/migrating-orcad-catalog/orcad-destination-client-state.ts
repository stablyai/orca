import type { PersistedState } from '../../../shared/persisted-state-types'
import { hostStableKey, parseHostStableKey } from '../../../shared/automation-owner-key'
import type {
  OrcadMigrationClientStatePayload,
  OrcadMigrationUiRoutingState
} from '../../../shared/orcad-migration-client-state'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'

export type PreparedOrcadMigrationClientState = {
  incoming: OrcadMigrationClientStatePayload | undefined
  mobileSelections: NonNullable<
    OrcadMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  >
  uiRouting: OrcadMigrationUiRoutingState | undefined
}

export function prepareOrcadMigrationClientState(
  incoming: OrcadMigrationClientStatePayload | undefined,
  state: PersistedState
): PreparedOrcadMigrationClientState {
  const mobileSelections = prepareMobileSelections(
    incoming?.mobileClientTabSelectionsByDeviceId,
    state
  )
  const uiRouting = incoming?.uiRouting ? normalizeUiRouting(incoming.uiRouting) : undefined
  if (uiRouting) {
    assertUiRoutingCompatible(uiRouting, state)
  }
  return {
    incoming,
    mobileSelections,
    uiRouting
  }
}

export function applyPreparedOrcadMigrationClientState(
  prepared: PreparedOrcadMigrationClientState,
  state: PersistedState
): void {
  if (Object.keys(prepared.mobileSelections).length > 0) {
    // Per workspace: a device's selections outside this import stay as they are.
    state.mobileClientTabSelectionsByDeviceId = { ...state.mobileClientTabSelectionsByDeviceId }
    for (const [deviceId, selections] of Object.entries(prepared.mobileSelections)) {
      state.mobileClientTabSelectionsByDeviceId[deviceId] = {
        ...state.mobileClientTabSelectionsByDeviceId[deviceId],
        ...selections
      }
    }
  }
  if (prepared.uiRouting) {
    applyUiRouting(prepared.uiRouting, state)
  }
}

function normalizeUiRouting(route: OrcadMigrationUiRoutingState): OrcadMigrationUiRoutingState {
  const filter = route.automationHostFilter
  if (filter?.kind !== 'host') {
    return structuredClone(route)
  }
  const parsed = parseHostStableKey(filter.hostKey)
  if (parsed?.authority.kind !== 'runtime' || parsed.selector.kind !== 'self') {
    return structuredClone(route)
  }
  return {
    ...structuredClone(route),
    automationHostFilter: {
      kind: 'host',
      hostKey: hostStableKey({ authority: { kind: 'desktop' }, selector: { kind: 'self' } })
    }
  }
}

function prepareMobileSelections(
  incoming: OrcadMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId'],
  state: PersistedState
): NonNullable<OrcadMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']> {
  const result: NonNullable<
    OrcadMigrationClientStatePayload['mobileClientTabSelectionsByDeviceId']
  > = {}
  const current = state.mobileClientTabSelectionsByDeviceId ?? {}
  for (const [deviceId, selections] of Object.entries(incoming ?? {})) {
    for (const [worktreeId, selection] of Object.entries(selections)) {
      const existing = current[deviceId]?.[worktreeId]
      if (
        existing &&
        serializeOrcadMigrationValue(existing) !== serializeOrcadMigrationValue(selection)
      ) {
        throw new Error(`orcad_migration_client_state_conflict:mobile:${deviceId}:${worktreeId}`)
      }
      const deviceSelections = (result[deviceId] ??= {})
      deviceSelections[worktreeId] = structuredClone(selection)
    }
  }
  return result
}

// What each routed field reads in this profile, and what it holds when never set.
const UI_ROUTING_FIELDS: readonly {
  key: keyof OrcadMigrationUiRoutingState
  read: (ui: PersistedState['ui']) => unknown
  empty: unknown
}[] = [
  { key: 'lastActiveRepoId', read: (ui) => ui.lastActiveRepoId, empty: null },
  { key: 'lastActiveWorktreeId', read: (ui) => ui.lastActiveWorktreeId, empty: null },
  { key: 'filterRepoIds', read: (ui) => ui.filterRepoIds, empty: [] },
  { key: 'showDotfilesByWorktree', read: (ui) => ui.showDotfilesByWorktree ?? {}, empty: {} },
  {
    key: 'setupScriptPromptDismissedRepoIds',
    read: (ui) => ui.setupScriptPromptDismissedRepoIds ?? [],
    empty: []
  },
  { key: 'manualRepoOrder', read: (ui) => ui.manualRepoOrder ?? [], empty: [] },
  { key: 'workspaceHostScope', read: (ui) => ui.workspaceHostScope, empty: undefined },
  { key: 'visibleWorkspaceHostIds', read: (ui) => ui.visibleWorkspaceHostIds, empty: null },
  { key: 'workspaceHostOrder', read: (ui) => ui.workspaceHostOrder ?? [], empty: [] },
  { key: 'automationHostFilter', read: (ui) => ui.automationHostFilter, empty: undefined },
  {
    key: 'acknowledgedAgentsByPaneKey',
    read: (ui) => ui.acknowledgedAgentsByPaneKey ?? {},
    empty: {}
  }
]

function assertUiRoutingCompatible(
  route: OrcadMigrationUiRoutingState,
  state: PersistedState
): void {
  for (const { key, read, empty } of UI_ROUTING_FIELDS) {
    const current = serializeOrcadMigrationValue(read(state.ui))
    if (
      route[key] !== undefined &&
      current !== serializeOrcadMigrationValue(route[key]) &&
      current !== serializeOrcadMigrationValue(empty)
    ) {
      throw new Error(`orcad_migration_client_state_conflict:ui:${key}`)
    }
  }
}

function applyUiRouting(route: OrcadMigrationUiRoutingState, state: PersistedState): void {
  const ui = state.ui
  if (route.lastActiveRepoId !== undefined) {
    ui.lastActiveRepoId = route.lastActiveRepoId
  }
  if (route.lastActiveWorktreeId !== undefined) {
    ui.lastActiveWorktreeId = route.lastActiveWorktreeId
  }
  if (route.filterRepoIds !== undefined) {
    ui.filterRepoIds = structuredClone(route.filterRepoIds)
  }
  if (route.showDotfilesByWorktree !== undefined) {
    ui.showDotfilesByWorktree = {
      ...ui.showDotfilesByWorktree,
      ...structuredClone(route.showDotfilesByWorktree)
    }
  }
  if (route.setupScriptPromptDismissedRepoIds !== undefined) {
    ui.setupScriptPromptDismissedRepoIds = structuredClone(route.setupScriptPromptDismissedRepoIds)
  }
  if (route.manualRepoOrder !== undefined) {
    ui.manualRepoOrder = structuredClone(route.manualRepoOrder)
  }
  if (route.workspaceHostScope !== undefined) {
    ui.workspaceHostScope = route.workspaceHostScope
  }
  if (route.visibleWorkspaceHostIds !== undefined) {
    ui.visibleWorkspaceHostIds = structuredClone(route.visibleWorkspaceHostIds)
  }
  if (route.workspaceHostOrder !== undefined) {
    ui.workspaceHostOrder = structuredClone(route.workspaceHostOrder)
  }
  if (route.automationHostFilter !== undefined) {
    ui.automationHostFilter = structuredClone(route.automationHostFilter)
  }
  if (route.acknowledgedAgentsByPaneKey !== undefined) {
    ui.acknowledgedAgentsByPaneKey = {
      ...ui.acknowledgedAgentsByPaneKey,
      ...structuredClone(route.acknowledgedAgentsByPaneKey)
    }
  }
}
