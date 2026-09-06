import { randomUUID } from 'node:crypto'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeAutomationPrecheck } from '../../../shared/automation-precheck'
import { nextAutomationOccurrenceAfter } from '../../../shared/automation-schedule-occurrences'
import {
  applyAutomationExecutionTarget,
  deriveAutomationExecutionTargetForCreate,
  deriveAutomationExecutionTargetForUpdate
} from '../../../shared/automation-execution-target'
import {
  assertAutomationDestination,
  assertAutomationOwnerFence,
  assertExecutionTargetMatchesDestination,
  type AutomationDestination,
  type AutomationOwnerPrecondition
} from '../../../shared/automation-owner-precondition'
import {
  getAutomationContextsForRepo,
  getAutomationSchedulerOwner,
  normalizeAutomationSessionReuse,
  normalizeAutomationSetupDecisionForWorkspaceMode
} from './automation-context-migration'
import {
  automationProjectionContext,
  automationWorkspaceSshPin,
  sshTargetGenerationForConnection,
  type AutomationStorageAuthority
} from './automation-owner-projection'

export type AutomationDefinitionOperations = {
  state: PersistedState
  storageAuthority: AutomationStorageAuthority
  flush: () => void
  recordCreated: () => void
}

export function listAutomations(state: PersistedState): Automation[] {
  return (state.automations ?? [])
    .map((automation) => normalizeAutomationSessionReuse(automation))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function createAutomation(
  operations: AutomationDefinitionOperations,
  input: AutomationCreateInput,
  options?: { destination?: AutomationDestination }
): Automation {
  if (input.creationKey) {
    const existing = (operations.state.automations ?? []).find(
      (automation) => automation.creationKey === input.creationKey
    )
    if (existing) {
      return existing
    }
  }
  const repo = operations.state.repos.find((entry) => entry.id === input.projectId)
  const now = Date.now()
  const workspaceId = input.workspaceMode === 'existing' ? (input.workspaceId ?? null) : null
  const workspaceSshPin = automationWorkspaceSshPin(operations.state, workspaceId)
  const executionTarget = deriveAutomationExecutionTargetForCreate({
    repo,
    sshTargetGeneration: sshTargetGenerationForConnection(operations.state, repo?.connectionId),
    workspaceSshPin
  })
  if (options?.destination) {
    const context = automationProjectionContext(
      operations.state,
      operations.storageAuthority,
      false
    )
    assertAutomationDestination(options.destination, context)
    assertExecutionTargetMatchesDestination(executionTarget, options.destination, workspaceSshPin)
  }
  const schedulerOwner = getAutomationSchedulerOwner(repo)
  const contexts = getAutomationContextsForRepo(repo, operations.state.projectHostSetups ?? [])
  const automation: Automation = {
    id: randomUUID(),
    ...(input.creationKey ? { creationKey: input.creationKey } : {}),
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    precheck: normalizeAutomationPrecheck(input.precheck),
    agentId: input.agentId,
    // Why own contexts win: a wire context speaks the client's perspective —
    // 'runtime:<id>' is a client-assigned name this store cannot interpret, and
    // persisting it makes the projection orphan a record this authority owns.
    runContext: contexts.runContext ?? input.runContext ?? null,
    sourceContext: contexts.sourceContext ?? input.sourceContext ?? null,
    projectId: input.projectId,
    ...executionTarget,
    schedulerOwner,
    workspaceMode: input.workspaceMode,
    workspaceId,
    baseBranch: input.workspaceMode === 'new_per_run' ? (input.baseBranch ?? null) : null,
    setupDecision: normalizeAutomationSetupDecisionForWorkspaceMode(
      input.workspaceMode,
      input.setupDecision
    ),
    reuseSession: input.workspaceMode === 'existing' ? (input.reuseSession ?? false) : false,
    timezone: input.timezone,
    rrule: input.rrule,
    dtstart: input.dtstart,
    enabled: input.enabled ?? true,
    nextRunAt: nextAutomationOccurrenceAfter(input.rrule, input.dtstart, now),
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: input.missedRunGraceMinutes ?? 720,
    createdAt: now,
    updatedAt: now
  }
  operations.state.automations = [...(operations.state.automations ?? []), automation]
  operations.recordCreated()
  operations.flush()
  return automation
}

export function updateAutomation(
  operations: AutomationDefinitionOperations,
  id: string,
  updates: AutomationUpdateInput,
  options?: { expectedOwner?: AutomationOwnerPrecondition; destination?: AutomationDestination }
): Automation {
  const index = (operations.state.automations ?? []).findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error('Automation not found.')
  }
  const current = operations.state.automations[index]
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
  // Why: the renderer forwards a Partial verbatim, so `{ enabled: undefined }` survives structuredClone
  // and would blank the stored value in the spread below. Explicit clears go through the `null` branches.
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  ) as AutomationUpdateInput
  const repoId = updates.projectId ?? current.projectId
  const repo = operations.state.repos.find((entry) => entry.id === repoId)
  const selectorMoveRequested =
    updates.projectId !== undefined || options?.destination !== undefined
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
    runContext:
      definedUpdates.runContext === null
        ? null
        : selectorMoveRequested
          ? (contexts.runContext ?? definedUpdates.runContext ?? null)
          : (current.runContext ?? contexts.runContext),
    sourceContext:
      definedUpdates.sourceContext === null
        ? null
        : selectorMoveRequested
          ? (contexts.sourceContext ?? definedUpdates.sourceContext ?? null)
          : (current.sourceContext ?? contexts.sourceContext),
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
    setupDecision:
      workspaceMode === 'new_per_run'
        ? Object.hasOwn(definedUpdates, 'setupDecision')
          ? normalizeAutomationSetupDecisionForWorkspaceMode(
              workspaceMode,
              definedUpdates.setupDecision
            )
          : normalizeAutomationSetupDecisionForWorkspaceMode(workspaceMode, current.setupDecision)
        : undefined,
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
  const previousPin = automationWorkspaceSshPin(operations.state, current.workspaceId)
  const workspaceSshPin = automationWorkspaceSshPin(operations.state, merged.workspaceId)
  const workspaceSshPinMoved = previousPin?.targetId !== workspaceSshPin?.targetId
  const executionTarget = deriveAutomationExecutionTargetForUpdate({
    current,
    repo,
    selectorMoveRequested,
    sshTargetGeneration: sshTargetGenerationForConnection(operations.state, repo?.connectionId),
    workspaceSshPin,
    workspaceSshPinMoved
  })
  if (options?.destination) {
    assertExecutionTargetMatchesDestination(executionTarget, options.destination, workspaceSshPin)
  }
  const updated = applyAutomationExecutionTarget(
    merged,
    executionTarget,
    workspaceSshPinMoved ? undefined : workspaceSshPin
  )
  // Replaced, not patched in place: the list projection caches on array identity.
  operations.state.automations = operations.state.automations.map((entry) =>
    entry.id === id ? updated : entry
  )
  operations.flush()
  return updated
}

export function deleteAutomation(
  operations: AutomationDefinitionOperations,
  id: string,
  options?: { expectedOwner?: AutomationOwnerPrecondition }
): void {
  const automation = (operations.state.automations ?? []).find((entry) => entry.id === id)
  if (automation) {
    assertAutomationOwnerFence({
      automation,
      expectedOwner: options?.expectedOwner,
      operation: 'mutate',
      context: automationProjectionContext(operations.state, operations.storageAuthority, false)
    })
  }
  operations.state.automations = (operations.state.automations ?? []).filter(
    (entry) => entry.id !== id
  )
  operations.state.automationRuns = (operations.state.automationRuns ?? []).filter(
    (entry) => entry.automationId !== id
  )
  // Why: the automation and its unfinished runs were pinning their workspace; both are gone (#17775).
  invalidateLocalWorktreeMetadataPruneInputs()
  operations.flush()
}
