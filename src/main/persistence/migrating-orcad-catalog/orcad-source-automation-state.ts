import {
  isFinalAutomationRunStatus,
  type Automation,
  type AutomationRun
} from '../../../shared/automations-types'
import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

export type OrcadMigrationSourceAutomationInspection = {
  automations: Automation[]
  automationRuns: AutomationRun[]
  blockedAutomationCount: number
  blockedRunCount: number
}

export function collectOrcadMigrationSourceAutomationState(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload
): OrcadMigrationSourceAutomationInspection {
  const scope = createOrcadMigrationSourceScope({ source, catalog })
  const touchedAutomations = state.automations.filter((entry) =>
    automationTouchesScope(entry, scope)
  )
  const touchedAutomationIds = new Set(touchedAutomations.map((entry) => entry.id))
  const touchedRuns = state.automationRuns.filter(
    (entry) => touchedAutomationIds.has(entry.automationId) || runTouchesScope(entry, scope)
  )
  const runsByAutomationId = Map.groupBy(touchedRuns, (entry) => entry.automationId)
  const automationsById = Map.groupBy(touchedAutomations, (entry) => entry.id)
  const automations: Automation[] = []
  const automationRuns: AutomationRun[] = []
  let blockedAutomationCount = 0
  let blockedRunCount = 0

  for (const [automationId, matching] of automationsById) {
    const runs = runsByAutomationId.get(automationId) ?? []
    const eligible =
      matching.length === 1 &&
      automationCanTransfer(matching[0], scope) &&
      runs.every((run) => runCanTransfer(run, scope))
    if (!eligible) {
      blockedAutomationCount += matching.length
      blockedRunCount += runs.length
      continue
    }
    automations.push(projectAutomationToDestination(matching[0]))
    automationRuns.push(...runs.map(projectAutomationRunToDestination))
  }

  for (const [automationId, runs] of runsByAutomationId) {
    if (!automationsById.has(automationId)) {
      blockedRunCount += runs.length
    }
  }
  automations.sort((left, right) => compareKeys(left.id, right.id))
  automationRuns.sort((left, right) => compareKeys(left.id, right.id))
  return { automations, automationRuns, blockedAutomationCount, blockedRunCount }
}

export function retireOrcadMigrationSourceAutomationState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const automations = manifest.payload.dormantState?.automations ?? []
  const automationRuns = manifest.payload.dormantState?.automationRuns ?? []
  if (automations.length === 0 && automationRuns.length === 0) {
    return
  }
  const automationIds = new Set(automations.map((entry) => entry.id))
  const runIds = new Set(automationRuns.map((entry) => entry.id))
  state.automations = state.automations.filter((entry) => !automationIds.has(entry.id))
  state.automationRuns = state.automationRuns.filter((entry) => !runIds.has(entry.id))
}

export function assertOrcadMigrationSourceAutomationStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const automationIds = new Set(
    (manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id)
  )
  const runIds = new Set(
    (manifest.payload.dormantState?.automationRuns ?? []).map((entry) => entry.id)
  )
  if (
    state.automations.some((entry) => automationIds.has(entry.id)) ||
    state.automationRuns.some((entry) => runIds.has(entry.id))
  ) {
    throw new Error('orcad_migration_source_automation_state_reappeared')
  }
}

function automationTouchesScope(automation: Automation, scope: OrcadMigrationSourceScope): boolean {
  return (
    (automation.executionTargetType === 'ssh' && automation.executionTargetId === scope.targetId) ||
    (scope.targetGeneration !== null &&
      automation.executionTargetGeneration === scope.targetGeneration) ||
    scope.repoIds.has(getAutomationRunRepoId(automation)) ||
    orcadMigrationOwnerMatchesScope(automation.workspaceId, scope) ||
    contextTouchesScope(automation.runContext, scope) ||
    contextTouchesScope(automation.sourceContext, scope)
  )
}

function runTouchesScope(run: AutomationRun, scope: OrcadMigrationSourceScope): boolean {
  return (
    orcadMigrationOwnerMatchesScope(run.workspaceId, scope) ||
    contextTouchesScope(run.runContext, scope) ||
    contextTouchesScope(run.sourceContext, scope)
  )
}

function automationCanTransfer(automation: Automation, scope: OrcadMigrationSourceScope): boolean {
  return (
    automation.enabled === false &&
    automation.executionTargetType === 'ssh' &&
    automation.executionTargetId === scope.targetId &&
    automation.schedulerOwner === 'ssh_bridge' &&
    (automation.executionTargetGeneration === undefined ||
      automation.executionTargetGeneration === scope.targetGeneration) &&
    scope.repoIds.has(getAutomationRunRepoId(automation)) &&
    ownerCanTransfer(automation.workspaceId, scope) &&
    contextCanTransfer(automation.runContext, scope) &&
    contextCanTransfer(automation.sourceContext, scope)
  )
}

function runCanTransfer(run: AutomationRun, scope: OrcadMigrationSourceScope): boolean {
  return (
    isFinalAutomationRunStatus(run.status) &&
    ownerCanTransfer(run.workspaceId, scope) &&
    contextCanTransfer(run.runContext, scope) &&
    contextCanTransfer(run.sourceContext, scope)
  )
}

function ownerCanTransfer(value: string | null, scope: OrcadMigrationSourceScope): boolean {
  return value === null || orcadMigrationOwnerMatchesScope(value, scope)
}

function contextTouchesScope(
  context: WorkspaceRunContext | TaskSourceContext | null | undefined,
  scope: OrcadMigrationSourceScope
): boolean {
  return (
    context?.hostId === scope.hostId ||
    (typeof context?.repoId === 'string' && scope.repoIds.has(context.repoId))
  )
}

function contextCanTransfer(
  context: WorkspaceRunContext | TaskSourceContext | null | undefined,
  scope: OrcadMigrationSourceScope
): boolean {
  if (!context) {
    return true
  }
  return (
    context.hostId === scope.hostId &&
    typeof context.repoId === 'string' &&
    scope.repoIds.has(context.repoId) &&
    (!context.projectHostSetupId || context.projectHostSetupId === context.repoId)
  )
}

function projectAutomationToDestination(source: Automation): Automation {
  const destination: Automation = {
    ...structuredClone(source),
    runContext: projectContextToDestination(source.runContext),
    sourceContext: projectContextToDestination(source.sourceContext),
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'remote_host_service',
    workspaceId: projectOwnerToDestination(source.workspaceId)
  }
  delete destination.executionTargetGeneration
  return destination
}

function projectAutomationRunToDestination(source: AutomationRun): AutomationRun {
  return {
    ...structuredClone(source),
    runContext: projectContextToDestination(source.runContext),
    sourceContext: projectContextToDestination(source.sourceContext),
    workspaceId: projectOwnerToDestination(source.workspaceId)
  }
}

function projectContextToDestination<T extends WorkspaceRunContext | TaskSourceContext>(
  context: T | null | undefined
): T | null {
  if (!context) {
    return null
  }
  return {
    ...structuredClone(context),
    hostId: LOCAL_EXECUTION_HOST_ID,
    projectHostSetupId: context.repoId ?? null
  } as T
}

function projectOwnerToDestination(value: string | null): string | null {
  return value === null ? null : unqualifyOrcadMigrationOwnerKey(value)
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
