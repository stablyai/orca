import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  OrcadMigrationClientStatePayload,
  OrcadMigrationUiRoutingState
} from '../../../shared/orcad-migration/orcad-migration-client-state'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration/orcad-migration-manifest'

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
  const uiRouting = incoming?.uiRouting ? structuredClone(incoming.uiRouting) : undefined
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

type UiRoutingKey = keyof OrcadMigrationUiRoutingState
type UiRoutingFieldMerge<K extends UiRoutingKey> =
  /** Per-window filters stay on the desktop. */
  | 'desktop-only'
  /** Preserve the server's existing value. */
  | ((ui: PersistedState['ui'], value: NonNullable<OrcadMigrationUiRoutingState[K]>) => void)

// View state cannot block a move: preserve server values and merge acknowledgements by latest time.
export const ORCAD_MIGRATION_UI_ROUTING_MERGE: {
  readonly [K in UiRoutingKey]: UiRoutingFieldMerge<K>
} = {
  lastActiveRepoId: (ui, value) => {
    ui.lastActiveRepoId ??= value
  },
  lastActiveWorktreeId: (ui, value) => {
    ui.lastActiveWorktreeId ??= value
  },
  manualRepoOrder: (ui, value) => {
    if (!ui.manualRepoOrder?.length) {
      ui.manualRepoOrder = structuredClone(value)
    }
  },
  showDotfilesByWorktree: (ui, value) => {
    ui.showDotfilesByWorktree = { ...structuredClone(value), ...ui.showDotfilesByWorktree }
  },
  acknowledgedAgentsByPaneKey: (ui, value) => {
    // A retry must not revive an already-acknowledged unread mark.
    const merged = { ...ui.acknowledgedAgentsByPaneKey }
    for (const [paneKey, at] of Object.entries(value)) {
      merged[paneKey] = Math.max(merged[paneKey] ?? 0, at)
    }
    ui.acknowledgedAgentsByPaneKey = merged
  },
  setupScriptPromptDismissedRepoIds: (ui, value) => {
    ui.setupScriptPromptDismissedRepoIds = [
      ...new Set([...(ui.setupScriptPromptDismissedRepoIds ?? []), ...value])
    ]
  },
  filterRepoIds: 'desktop-only',
  workspaceHostScope: 'desktop-only',
  visibleWorkspaceHostIds: 'desktop-only',
  workspaceHostOrder: 'desktop-only',
  automationHostFilter: 'desktop-only'
}

const UI_ROUTING_KEYS = Object.keys(ORCAD_MIGRATION_UI_ROUTING_MERGE).filter(isUiRoutingKey)

function isUiRoutingKey(key: string): key is UiRoutingKey {
  return Object.hasOwn(ORCAD_MIGRATION_UI_ROUTING_MERGE, key)
}

function applyUiRouting(route: OrcadMigrationUiRoutingState, state: PersistedState): void {
  for (const key of UI_ROUTING_KEYS) {
    mergeUiRoutingField(key, route, state.ui)
  }
}

function mergeUiRoutingField<K extends UiRoutingKey>(
  key: K,
  route: OrcadMigrationUiRoutingState,
  ui: PersistedState['ui']
): void {
  const merge = ORCAD_MIGRATION_UI_ROUTING_MERGE[key]
  const value = route[key]
  if (merge !== 'desktop-only' && value !== undefined && value !== null) {
    merge(ui, value)
  }
}
