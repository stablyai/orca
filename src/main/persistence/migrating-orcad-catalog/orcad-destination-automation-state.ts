import { MAX_AUTOMATION_RUNS_PER_AUTOMATION } from '../../../shared/automation-run-retention'
import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { selectNewRows } from './orcad-catalog-row-identity'

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
  const newAutomations = selectNewRows(
    incomingAutomations,
    state.automations,
    dormantConflict('automation')
  )
  const newRuns = selectNewRows(
    incomingRuns,
    state.automationRuns,
    dormantConflict('automation_run')
  )
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

function dormantConflict(label: string): (id: string) => string {
  return (id) => `orcad_migration_dormant_id_conflict:${label}:${id}`
}
