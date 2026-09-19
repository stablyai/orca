import { MAX_AUTOMATION_RUNS_PER_AUTOMATION } from '../../../shared/automation-run-retention'
import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../../shared/automations-types'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'

export type PreparedOrcadMigrationAutomationState = {
  incomingAutomations: Automation[]
  incomingRuns: AutomationRun[]
  newAutomations: Automation[]
  newRuns: AutomationRun[]
}

export function prepareOrcadMigrationAutomationState(
  automations: readonly Automation[] | undefined,
  runs: readonly AutomationRun[] | undefined,
  state: PersistedState
): PreparedOrcadMigrationAutomationState {
  const incomingAutomations = (automations ?? []).map((entry) => structuredClone(entry))
  const incomingRuns = (runs ?? []).map((entry) => structuredClone(entry))
  const newAutomations = selectNewRows(incomingAutomations, state.automations, 'automation')
  const newRuns = selectNewRows(incomingRuns, state.automationRuns, 'automation_run')
  assertRunOwnersExist(incomingAutomations, incomingRuns, state.automations)
  assertRunRetentionCapacity(incomingAutomations, incomingRuns, state.automationRuns)
  return { incomingAutomations, incomingRuns, newAutomations, newRuns }
}

export function applyPreparedOrcadMigrationAutomationState(
  prepared: PreparedOrcadMigrationAutomationState,
  state: PersistedState
): void {
  if (prepared.newAutomations.length > 0) {
    state.automations = [...state.automations, ...prepared.newAutomations]
  }
  if (prepared.newRuns.length > 0) {
    state.automationRuns = [...state.automationRuns, ...prepared.newRuns]
  }
}

export function assertCommittedOrcadMigrationAutomationState(
  automations: readonly Automation[] | undefined,
  runs: readonly AutomationRun[] | undefined,
  state: PersistedState
): void {
  assertRowsExist(automations ?? [], state.automations, 'automation')
  assertRowsExist(runs ?? [], state.automationRuns, 'automation_run')
}

function selectNewRows<T extends { id: string }>(incoming: T[], existing: T[], label: string): T[] {
  const existingById = new Map(existing.map((entry) => [entry.id, entry]))
  return incoming.filter((entry) => {
    const current = existingById.get(entry.id)
    if (!current) {
      return true
    }
    assertSameValue(current, entry, `${label}:${entry.id}`)
    return false
  })
}

function assertRowsExist<T extends { id: string }>(
  incoming: readonly T[],
  existing: readonly T[],
  label: string
): void {
  const existingById = new Map(existing.map((entry) => [entry.id, entry]))
  for (const entry of incoming) {
    const current = existingById.get(entry.id)
    if (!current) {
      throw new Error(`orcad_migration_receipt_dormant_mismatch:${label}:${entry.id}`)
    }
    assertSameValue(current, entry, `receipt_dormant_mismatch:${label}:${entry.id}`)
  }
}

function assertRunOwnersExist(
  incomingAutomations: readonly Automation[],
  incomingRuns: readonly AutomationRun[],
  existingAutomations: readonly Automation[]
): void {
  const automationIds = new Set([
    ...existingAutomations.map((entry) => entry.id),
    ...incomingAutomations.map((entry) => entry.id)
  ])
  for (const run of incomingRuns) {
    if (!automationIds.has(run.automationId)) {
      throw new Error(`orcad_migration_dormant_automation_run_owner_missing:${run.id}`)
    }
  }
}

function assertRunRetentionCapacity(
  incomingAutomations: readonly Automation[],
  incomingRuns: readonly AutomationRun[],
  existingRuns: readonly AutomationRun[]
): void {
  const incomingAutomationIds = new Set(incomingAutomations.map((entry) => entry.id))
  const idsByAutomation = new Map<string, Set<string>>()
  for (const run of [
    ...existingRuns.filter((entry) => incomingAutomationIds.has(entry.automationId)),
    ...incomingRuns
  ]) {
    if (!isFinalAutomationRunStatus(run.status)) {
      throw new Error(`orcad_migration_dormant_automation_run_active:${run.automationId}`)
    }
    const ids = idsByAutomation.get(run.automationId) ?? new Set<string>()
    ids.add(run.id)
    idsByAutomation.set(run.automationId, ids)
  }
  for (const [automationId, ids] of idsByAutomation) {
    if (ids.size > MAX_AUTOMATION_RUNS_PER_AUTOMATION) {
      throw new Error(`orcad_migration_dormant_automation_run_capacity:${automationId}`)
    }
  }
}

function assertSameValue(left: unknown, right: unknown, label: string): void {
  if (serializeOrcadMigrationValue(left) !== serializeOrcadMigrationValue(right)) {
    throw new Error(`orcad_migration_dormant_id_conflict:${label}`)
  }
}
