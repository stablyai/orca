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
    state.mobileClientTabSelectionsByDeviceId = {
      ...state.mobileClientTabSelectionsByDeviceId,
      ...prepared.mobileSelections
    }
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

export function assertCommittedOrcadMigrationClientState(
  incoming: OrcadMigrationClientStatePayload | undefined,
  state: PersistedState
): void {
  if (!incoming) {
    return
  }
  prepareOrcadMigrationClientState(incoming, state)
  const current = state.mobileClientTabSelectionsByDeviceId ?? {}
  for (const [deviceId, selections] of Object.entries(
    incoming.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    for (const [worktreeId, selection] of Object.entries(selections)) {
      const actual = current[deviceId]?.[worktreeId]
      if (
        !actual ||
        serializeOrcadMigrationValue(actual) !== serializeOrcadMigrationValue(selection)
      ) {
        throw new Error(
          `orcad_migration_receipt_client_state_mismatch:mobile:${deviceId}:${worktreeId}`
        )
      }
    }
  }
  const uiRouting = incoming.uiRouting ? normalizeUiRouting(incoming.uiRouting) : undefined
  if (uiRouting) {
    assertUiRoutingApplied(uiRouting, state)
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

function assertUiRoutingCompatible(
  route: OrcadMigrationUiRoutingState,
  state: PersistedState
): void {
  const ui = state.ui
  assertOptionalValue(route.lastActiveRepoId, ui.lastActiveRepoId, null, 'last-active-repo')
  assertOptionalValue(
    route.lastActiveWorktreeId,
    ui.lastActiveWorktreeId,
    null,
    'last-active-worktree'
  )
  assertOptionalArray(route.filterRepoIds, ui.filterRepoIds, 'filter-repos')
  assertOptionalValue(
    route.showDotfilesByWorktree,
    ui.showDotfilesByWorktree ?? {},
    {},
    'show-dotfiles'
  )
  assertOptionalArray(
    route.setupScriptPromptDismissedRepoIds,
    ui.setupScriptPromptDismissedRepoIds ?? [],
    'setup-dismissed'
  )
  assertOptionalArray(route.manualRepoOrder, ui.manualRepoOrder ?? [], 'manual-order')
  assertOptionalValue(route.workspaceHostScope, ui.workspaceHostScope, undefined, 'host-scope')
  assertOptionalValue(
    route.visibleWorkspaceHostIds,
    ui.visibleWorkspaceHostIds,
    null,
    'visible-hosts'
  )
  assertOptionalArray(route.workspaceHostOrder, ui.workspaceHostOrder ?? [], 'host-order')
  assertOptionalValue(
    route.automationHostFilter,
    ui.automationHostFilter,
    undefined,
    'automation-filter'
  )
  assertOptionalValue(
    route.acknowledgedAgentsByPaneKey,
    ui.acknowledgedAgentsByPaneKey ?? {},
    {},
    'acknowledgements'
  )
}

function assertUiRoutingApplied(route: OrcadMigrationUiRoutingState, state: PersistedState): void {
  const ui = state.ui
  const fields: [keyof OrcadMigrationUiRoutingState, unknown][] = [
    ['lastActiveRepoId', ui.lastActiveRepoId],
    ['lastActiveWorktreeId', ui.lastActiveWorktreeId],
    ['filterRepoIds', ui.filterRepoIds],
    ['showDotfilesByWorktree', ui.showDotfilesByWorktree ?? {}],
    ['setupScriptPromptDismissedRepoIds', ui.setupScriptPromptDismissedRepoIds ?? []],
    ['manualRepoOrder', ui.manualRepoOrder ?? []],
    ['workspaceHostScope', ui.workspaceHostScope],
    ['visibleWorkspaceHostIds', ui.visibleWorkspaceHostIds],
    ['workspaceHostOrder', ui.workspaceHostOrder ?? []],
    ['automationHostFilter', ui.automationHostFilter],
    ['acknowledgedAgentsByPaneKey', ui.acknowledgedAgentsByPaneKey ?? {}]
  ]
  for (const [key, actual] of fields) {
    const expected = route[key]
    if (
      expected !== undefined &&
      serializeOrcadMigrationValue(actual) !== serializeOrcadMigrationValue(expected)
    ) {
      throw new Error(`orcad_migration_receipt_client_state_mismatch:ui:${String(key)}`)
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

function assertOptionalValue(
  incoming: unknown,
  current: unknown,
  empty: unknown,
  field: string
): void {
  if (
    incoming === undefined ||
    serializeOrcadMigrationValue(current) === serializeOrcadMigrationValue(incoming)
  ) {
    return
  }
  if (serializeOrcadMigrationValue(current) !== serializeOrcadMigrationValue(empty)) {
    throw new Error(`orcad_migration_client_state_conflict:ui:${field}`)
  }
}

function assertOptionalArray(
  incoming: unknown[] | undefined,
  current: unknown[],
  field: string
): void {
  assertOptionalValue(incoming, current, [], field)
}
