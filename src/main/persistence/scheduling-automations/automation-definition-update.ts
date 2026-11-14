import { retainAutomationReselectionContexts } from './automation-host-reselection'
import { getRepoSshConnectionId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { findAutomationRepoForWrite } from '../../../shared/automations/ownership/automation-repo-target'
import {
  applyAutomationLaunchSetupPatch,
  automationWithLaunchSetup
} from '../../../shared/automations/launch/automation-launch-setup'
import { automationCanonicalLaunchSetup } from '../../../shared/automations/launch/automation-canonical-launch-setup'
import type {
  Automation,
  AutomationUpdateInput
} from '../../../shared/automations/automation-definition'
import { normalizeAutomationPrecheck } from '../../../shared/automations/launch/automation-precheck'
import { assertAutomationExtraAgentArgs } from '../../../shared/automations/launch/automation-extra-agent-args-record'
import { nextAutomationOccurrenceAfter } from '../../../shared/automations/scheduling/automation-schedule-occurrences'
import {
  applyAutomationExecutionTarget,
  deriveAutomationExecutionTargetForUpdate
} from '../../../shared/automations/ownership/automation-execution-target'
import {
  assertAutomationDestination,
  assertAutomationOwnerFence,
  assertAutomationWorkspaceModePrecondition,
  assertExecutionTargetMatchesDestination,
  type AutomationUpdatePreconditions
} from '../../../shared/automations/ownership/automation-owner-precondition'
import {
  getAutomationContextsForRepo,
  automationContextAfterUpdate,
  getAutomationSchedulerOwner,
  applyAutomationSetupTrust,
  normalizeAutomationSetupDecisionForWorkspaceMode
} from './automation-context-migration'
import { refuseManagedOrcadHost } from '../../automations/ownership/orcad-fenced-automation'
import {
  automationProjectionContext,
  automationWorkspaceSshPin,
  sshTargetGenerationForConnection
} from './automation-owner-projection'
import type { AutomationDefinitionOperations } from './automation-definition-operations'

export type AutomationBatchUpdate = { id: string; updates: AutomationUpdateInput }

export type AutomationBatchUpdateResult =
  | { id: string; automation: Automation }
  | { id: string; error: unknown }

/**
 * Applies each update as `updateAutomation` would, but replaces the list and flushes once for the
 * whole batch. Why: per-row writes re-copy every stored automation once per row. One row's refusal
 * (missing, fenced) is its own result and never blocks the others.
 */
export function updateAutomations(
  operations: AutomationDefinitionOperations,
  batch: readonly AutomationBatchUpdate[]
): AutomationBatchUpdateResult[] {
  const byId = new Map((operations.state.automations ?? []).map((entry) => [entry.id, entry]))
  const written = new Map<string, Automation>()
  const results = batch.map(({ id, updates }): AutomationBatchUpdateResult => {
    const current = written.get(id) ?? byId.get(id)
    if (!current) {
      return { id, error: new Error('Automation not found.') }
    }
    try {
      const updated = mergeAutomationUpdate(operations, current, updates)
      written.set(id, updated)
      return { id, automation: automationWithLaunchSetup(updated) }
    } catch (error) {
      return { id, error }
    }
  })
  if (written.size > 0) {
    // Replace the array to invalidate identity-keyed list projections.
    operations.state.automations = operations.state.automations.map(
      (entry) => written.get(entry.id) ?? entry
    )
    operations.flush()
  }
  return results
}

export function updateAutomation(
  operations: AutomationDefinitionOperations,
  id: string,
  updates: AutomationUpdateInput,
  options?: AutomationUpdatePreconditions & { resolvedRepo?: Repo }
): Automation {
  const current = (operations.state.automations ?? []).find((entry) => entry.id === id)
  if (!current) {
    throw new Error('Automation not found.')
  }
  const updated = mergeAutomationUpdate(operations, current, updates, options)
  // Replace the array to invalidate identity-keyed list projections.
  operations.state.automations = operations.state.automations.map((entry) =>
    entry.id === id ? updated : entry
  )
  operations.flush()
  return automationWithLaunchSetup(updated)
}

/** The stored record `updates` makes of `current`, checked but not yet written. */
export function mergeAutomationUpdate(
  operations: AutomationDefinitionOperations,
  current: Automation,
  updates: AutomationUpdateInput,
  options?: AutomationUpdatePreconditions & { resolvedRepo?: Repo }
): Automation {
  const projectionContext = automationProjectionContext(
    operations.state,
    operations.storageAuthority,
    false
  )
  assertAutomationOwnerFence({
    automation: current,
    expectedOwner: options?.expectedOwner,
    operation: 'mutate',
    context: projectionContext
  })
  if (options?.destination) {
    assertAutomationDestination(options.destination, projectionContext)
  }
  assertAutomationWorkspaceModePrecondition(current, options?.expectedWorkspaceMode)
  const retainContexts = retainAutomationReselectionContexts(
    operations.state,
    current,
    updates,
    options?.destination,
    projectionContext
  )
  const launchSetupUpdate = applyAutomationLaunchSetupPatch(updates, current)
  // Ignore undefined values preserved by structuredClone; explicit clears use null.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: filtering removes only undefined entries from the validated patch and retains every remaining field's type.
  const definedUpdates = Object.fromEntries(
    Object.entries(launchSetupUpdate).filter(([, value]) => value !== undefined)
  ) as Omit<AutomationUpdateInput, 'launchSetupPatch'> & Pick<Automation, 'surface'>
  const repoId = updates.projectId ?? current.projectId
  const selectorMoveRequested =
    updates.projectId !== undefined || options?.destination !== undefined
  const repo = findAutomationRepoForWrite(
    operations.state.repos,
    repoId,
    updates.runContext ?? (selectorMoveRequested ? undefined : current.runContext),
    options?.resolvedRepo,
    !!updates.runContext
  )
  const schedulerOwner =
    selectorMoveRequested && repo ? getAutomationSchedulerOwner(repo) : current.schedulerOwner
  const contexts = getAutomationContextsForRepo(repo, operations.state.projectHostSetups ?? [])
  const rrule = updates.rrule ?? current.rrule
  const dtstart = updates.dtstart ?? current.dtstart
  const scheduleChanged = updates.rrule !== undefined || updates.dtstart !== undefined
  const workspaceMode = updates.workspaceMode ?? current.workspaceMode
  const merged: Automation = {
    ...current,
    ...definedUpdates,
    name: updates.name !== undefined ? updates.name.trim() || 'Untitled automation' : current.name,
    precheck: Object.hasOwn(definedUpdates, 'precheck')
      ? normalizeAutomationPrecheck(definedUpdates.precheck)
      : normalizeAutomationPrecheck(current.precheck),
    projectId: repoId,
    // Why the wire object is ignored: contexts are the storing authority's own
    // registry speaking. A move restates them from that registry, anything else
    // keeps the stored value; an explicit null still clears.
    runContext: retainContexts
      ? current.runContext
      : automationContextAfterUpdate(
          current.runContext,
          definedUpdates.runContext,
          contexts.runContext,
          selectorMoveRequested
        ),
    sourceContext: retainContexts
      ? current.sourceContext
      : automationContextAfterUpdate(
          current.sourceContext,
          definedUpdates.sourceContext,
          contexts.sourceContext,
          selectorMoveRequested
        ),
    schedulerOwner,
    workspaceMode,
    workspaceId:
      workspaceMode === 'existing'
        ? Object.hasOwn(definedUpdates, 'workspaceId')
          ? (definedUpdates.workspaceId ?? null)
          : current.workspaceId
        : null,
    baseBranch:
      workspaceMode === 'new_per_run'
        ? Object.hasOwn(definedUpdates, 'baseBranch')
          ? (definedUpdates.baseBranch ?? null)
          : (current.baseBranch ?? null)
        : null,
    setupDecision: normalizeAutomationSetupDecisionForWorkspaceMode(
      workspaceMode,
      Object.hasOwn(definedUpdates, 'setupDecision')
        ? definedUpdates.setupDecision
        : current.setupDecision
    ),
    reuseSession:
      workspaceMode === 'existing'
        ? (updates.reuseSession ?? current.reuseSession ?? false)
        : false,
    rrule,
    dtstart,
    nextRunAt: scheduleChanged
      ? nextAutomationOccurrenceAfter(rrule, dtstart, Date.now())
      : current.nextRunAt,
    updatedAt: Date.now()
  }
  if (retainContexts && !Object.hasOwn(current, 'sourceContext')) {
    delete merged.sourceContext
  }
  applyAutomationSetupTrust(merged, definedUpdates, current)
  delete merged.launchSetup
  for (const key of ['surface', 'launchPreferences', 'agentArgs', 'extraAgentArgs'] as const) {
    delete merged[key]
  }
  Object.assign(merged, automationCanonicalLaunchSetup(launchSetupUpdate))
  assertAutomationExtraAgentArgs(merged)
  const previousPin = automationWorkspaceSshPin(operations.state, current.workspaceId)
  const workspaceSshPin = automationWorkspaceSshPin(operations.state, merged.workspaceId)
  const workspaceSshPinMoved = previousPin?.targetId !== workspaceSshPin?.targetId
  const executionTarget = deriveAutomationExecutionTargetForUpdate({
    current,
    repo,
    selectorMoveRequested,
    sshTargetGeneration: sshTargetGenerationForConnection(
      operations.state,
      repo ? getRepoSshConnectionId(repo) : undefined
    ),
    workspaceSshPin,
    workspaceSshPinMoved
  })
  refuseManagedOrcadHost(operations.state, executionTarget, workspaceSshPin, current, previousPin)
  if (options?.destination) {
    assertExecutionTargetMatchesDestination(executionTarget, options.destination, workspaceSshPin)
  }
  return applyAutomationExecutionTarget(
    merged,
    executionTarget,
    workspaceSshPinMoved ? undefined : workspaceSshPin
  )
}
