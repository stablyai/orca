import {
  serializeOrcadMigrationValue,
  type OrcadMigrationDormantStatePayload,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { SparsePreset } from '../../../shared/worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { omitDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'
import { assertOrcadDestinationCanonicalMetadata } from './orcad-destination-worktree-metadata'
import {
  mergeRetiredNameRegistries,
  type RetiredNameRegistry
} from '../../../shared/worktree/retired-name-registry'
import { recordRetirementNamespaceRegistry } from '../../worktree-retirement-namespace'
import {
  applyPreparedOrcadMigrationWorkspaceSession,
  assertCommittedOrcadMigrationWorkspaceSession,
  prepareOrcadMigrationWorkspaceSession,
  type PreparedOrcadMigrationWorkspaceSession
} from './orcad-destination-workspace-session'
import {
  applyPreparedOrcadMigrationAutomationState,
  assertCommittedOrcadMigrationAutomationState,
  prepareOrcadMigrationAutomationState,
  type PreparedOrcadMigrationAutomationState
} from './orcad-destination-automation-state'
import {
  applyPreparedOrcadMigrationClientState,
  assertCommittedOrcadMigrationClientState,
  prepareOrcadMigrationClientState,
  type PreparedOrcadMigrationClientState
} from './orcad-destination-client-state'

type KeyedRow<T> = { key: string; value: T }
type RegistryUpdate = { key: string; value: RetiredNameRegistry }

export type PreparedOrcadMigrationDormantState = {
  payload: OrcadMigrationDormantStatePayload | undefined
  newWorktreeMeta: KeyedRow<WorktreeMeta>[]
  newWorktreeLineage: KeyedRow<WorktreeLineage>[]
  newWorkspaceLineage: KeyedRow<WorkspaceLineage>[]
  newSparsePresets: SparsePreset[]
  retiredNameUpdates: RegistryUpdate[]
  retirementNamespaceUpdates: RegistryUpdate[]
  workspaceSession: PreparedOrcadMigrationWorkspaceSession
  automationState: PreparedOrcadMigrationAutomationState
  clientState: PreparedOrcadMigrationClientState
}

export function prepareOrcadMigrationDormantState(
  manifest: OrcadMigrationManifest,
  state: PersistedState
): PreparedOrcadMigrationDormantState {
  const payload = manifest.payload.dormantState
  if (!payload) {
    return emptyPreparedDormantState()
  }
  assertOrcadDestinationCanonicalMetadata(state, payload.worktreeMeta)
  const worktreeMeta = payload.worktreeMeta.map((entry) => ({
    key: entry.worktreeId,
    value: structuredClone(entry.meta)
  }))
  const worktreeLineage = payload.worktreeLineage.map((entry) => ({
    key: entry.worktreeId,
    value: structuredClone(entry.lineage)
  }))
  const workspaceLineage = payload.workspaceLineage.map((entry) => ({
    key: entry.childWorkspaceKey,
    value: structuredClone(entry.lineage)
  }))
  const existingPresets = new Map(
    Object.values(state.sparsePresetsByRepo)
      .flat()
      .map((preset) => [sparsePresetKey(preset), preset])
  )
  const newSparsePresets = payload.sparsePresets.filter((preset) => {
    const existing = existingPresets.get(sparsePresetKey(preset))
    if (!existing) {
      return true
    }
    assertSameValue(existing, preset, `sparse_preset:${preset.repoId}:${preset.id}`)
    return false
  })
  return {
    payload,
    newWorktreeMeta: selectNewKeyedRows(
      worktreeMeta,
      state.worktreeMeta,
      'worktree_meta',
      omitDefaultWorktreeMetaFields
    ),
    newWorktreeLineage: selectNewKeyedRows(
      worktreeLineage,
      state.worktreeLineageById,
      'worktree_lineage'
    ),
    newWorkspaceLineage: selectNewKeyedRows(
      workspaceLineage,
      state.workspaceLineageByChildKey,
      'workspace_lineage'
    ),
    newSparsePresets,
    retiredNameUpdates: payload.retiredWorktreeNames.map((entry) => ({
      key: entry.repoId,
      value: mergeRetiredNameRegistries(
        state.retiredWorktreeNamesByRepo?.[entry.repoId] ?? { exhaustedTiers: 0, names: [] },
        entry.registry
      )
    })),
    retirementNamespaceUpdates: payload.retiredWorktreeNamespaces.map((entry) => ({
      key: entry.namespaceKey,
      value: mergeRetiredNameRegistries(
        state.retiredWorktreeNamesByNamespace?.[entry.namespaceKey] ?? {
          exhaustedTiers: 0,
          names: []
        },
        entry.registry
      )
    })),
    workspaceSession: prepareOrcadMigrationWorkspaceSession(payload.workspaceSession, state),
    automationState: prepareOrcadMigrationAutomationState(
      payload.automations,
      payload.automationRuns,
      state
    ),
    clientState: prepareOrcadMigrationClientState(payload.clientState, state)
  }
}

export function applyPreparedOrcadMigrationDormantState(
  prepared: PreparedOrcadMigrationDormantState,
  state: PersistedState
): void {
  for (const entry of prepared.newWorktreeMeta) {
    state.worktreeMeta[entry.key] = entry.value
  }
  for (const entry of prepared.newWorktreeLineage) {
    state.worktreeLineageById[entry.key] = entry.value
  }
  for (const entry of prepared.newWorkspaceLineage) {
    state.workspaceLineageByChildKey[entry.key] = entry.value
  }
  for (const preset of prepared.newSparsePresets) {
    state.sparsePresetsByRepo[preset.repoId] = [
      ...(state.sparsePresetsByRepo[preset.repoId] ?? []),
      preset
    ]
  }
  if (prepared.retiredNameUpdates.length > 0) {
    state.retiredWorktreeNamesByRepo ??= {}
    for (const entry of prepared.retiredNameUpdates) {
      state.retiredWorktreeNamesByRepo[entry.key] = entry.value
    }
  }
  if (prepared.retirementNamespaceUpdates.length > 0) {
    state.retiredWorktreeNamesByNamespace ??= {}
    for (const entry of prepared.retirementNamespaceUpdates) {
      recordRetirementNamespaceRegistry(
        state.retiredWorktreeNamesByNamespace,
        entry.key,
        entry.value
      )
    }
  }
  applyPreparedOrcadMigrationWorkspaceSession(prepared.workspaceSession, state)
  applyPreparedOrcadMigrationAutomationState(prepared.automationState, state)
  applyPreparedOrcadMigrationClientState(prepared.clientState, state)
}

export function assertCommittedOrcadMigrationDormantState(
  manifest: OrcadMigrationManifest,
  state: PersistedState
): void {
  const payload = manifest.payload.dormantState
  if (!payload) {
    return
  }
  assertOrcadDestinationCanonicalMetadata(state, payload.worktreeMeta)
  assertKeyedRows(
    payload.worktreeMeta.map((entry) => ({ key: entry.worktreeId, value: entry.meta })),
    state.worktreeMeta,
    'worktree_meta',
    omitDefaultWorktreeMetaFields
  )
  assertKeyedRows(
    payload.worktreeLineage.map((entry) => ({ key: entry.worktreeId, value: entry.lineage })),
    state.worktreeLineageById,
    'worktree_lineage'
  )
  assertKeyedRows(
    payload.workspaceLineage.map((entry) => ({
      key: entry.childWorkspaceKey,
      value: entry.lineage
    })),
    state.workspaceLineageByChildKey,
    'workspace_lineage'
  )
  const presetByKey = new Map(
    Object.values(state.sparsePresetsByRepo)
      .flat()
      .map((preset) => [sparsePresetKey(preset), preset])
  )
  for (const preset of payload.sparsePresets) {
    const current = presetByKey.get(sparsePresetKey(preset))
    if (!current) {
      throw new Error(`orcad_migration_receipt_dormant_mismatch:sparse_preset:${preset.id}`)
    }
    assertSameValue(current, preset, `receipt_dormant_mismatch:sparse_preset:${preset.id}`)
  }
  for (const entry of payload.retiredWorktreeNames) {
    assertRegistryContains(
      state.retiredWorktreeNamesByRepo?.[entry.repoId],
      entry.registry,
      `retired_names:${entry.repoId}`
    )
  }
  for (const entry of payload.retiredWorktreeNamespaces) {
    assertRegistryContains(
      state.retiredWorktreeNamesByNamespace?.[entry.namespaceKey],
      entry.registry,
      `retirement_namespace:${entry.namespaceKey}`
    )
  }
  assertCommittedOrcadMigrationWorkspaceSession(payload.workspaceSession, state)
  assertCommittedOrcadMigrationAutomationState(payload.automations, payload.automationRuns, state)
  assertCommittedOrcadMigrationClientState(payload.clientState, state)
}

function selectNewKeyedRows<T>(
  incoming: KeyedRow<T>[],
  existing: Record<string, T>,
  label: string,
  canonicalize: (value: T) => T = (value) => value
): KeyedRow<T>[] {
  return incoming.filter((entry) => {
    const current = existing[entry.key]
    if (current === undefined) {
      return true
    }
    assertSameValue(canonicalize(current), canonicalize(entry.value), `${label}:${entry.key}`)
    return false
  })
}

function assertKeyedRows<T>(
  incoming: KeyedRow<T>[],
  existing: Record<string, T>,
  label: string,
  canonicalize: (value: T) => T = (value) => value
): void {
  for (const entry of incoming) {
    const current = existing[entry.key]
    if (current === undefined) {
      throw new Error(`orcad_migration_receipt_dormant_mismatch:${label}:${entry.key}`)
    }
    assertSameValue(
      canonicalize(current),
      canonicalize(entry.value),
      `receipt_dormant_mismatch:${label}:${entry.key}`
    )
  }
}

function assertRegistryContains(
  current: RetiredNameRegistry | undefined,
  incoming: RetiredNameRegistry,
  label: string
): void {
  if (
    !current ||
    serializeOrcadMigrationValue(mergeRetiredNameRegistries(current, incoming)) !==
      serializeOrcadMigrationValue(current)
  ) {
    throw new Error(`orcad_migration_receipt_dormant_mismatch:${label}`)
  }
}

function assertSameValue(left: unknown, right: unknown, label: string): void {
  if (serializeOrcadMigrationValue(left) !== serializeOrcadMigrationValue(right)) {
    throw new Error(`orcad_migration_dormant_id_conflict:${label}`)
  }
}

const sparsePresetKey = (preset: Pick<SparsePreset, 'id' | 'repoId'>): string =>
  `${preset.repoId}\0${preset.id}`

function emptyPreparedDormantState(): PreparedOrcadMigrationDormantState {
  return {
    payload: undefined,
    newWorktreeMeta: [],
    newWorktreeLineage: [],
    newWorkspaceLineage: [],
    newSparsePresets: [],
    retiredNameUpdates: [],
    retirementNamespaceUpdates: [],
    workspaceSession: { incoming: undefined, merged: undefined },
    automationState: {
      incomingAutomations: [],
      incomingRuns: [],
      newAutomations: [],
      newRuns: []
    },
    clientState: {
      incoming: undefined,
      mobileSelections: {},
      uiRouting: undefined
    }
  }
}
