import { retainAutomationReselectionContexts } from './automation-host-reselection'
import { getRepoSshConnectionId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { findAutomationRepoForWrite } from '../../../shared/automation-repo-target'
import {
  applyAutomationLaunchSetupPatch,
  automationWithLaunchSetup
} from '../../../shared/automation-launch-setup'
import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeAutomationPrecheck } from '../../../shared/automation-precheck'
import {
  assertAutomationExtraAgentArgs,
  storedExtraAgentArgs
} from '../../../shared/automation-extra-agent-args-record'
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
  automationContextAfterUpdate,
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
  recordAutomationRunsMutation?: (runs: readonly AutomationRun[]) => void
}

export function listAutomations(state: PersistedState): Automation[] {
  return (state.automations ?? [])
    .map((automation) => automationWithLaunchSetup(normalizeAutomationSessionReuse(automation)))
    .sort((left, right) => left.name.localeCompare(right.name))
}

export function createAutomation(
  operations: AutomationDefinitionOperations,
  input: AutomationCreateInput,
  options?: { destination?: AutomationDestination; resolvedRepo?: Repo }
): Automation {
  if (input.creationKey) {
    const existing = (operations.state.automations ?? []).find(
      (automation) => automation.creationKey === input.creationKey
    )
    if (existing) {
      return automationWithLaunchSetup(existing)
    }
  }
  const repo = findAutomationRepoForWrite(
    operations.state.repos,
    input.projectId,
    input.runContext,
    options?.resolvedRepo
  )
  const now = Date.now()
  const workspaceId = input.workspaceMode === 'existing' ? (input.workspaceId ?? null) : null
  const workspaceSshPin = automationWorkspaceSshPin(operations.state, workspaceId)
  const executionTarget = deriveAutomationExecutionTargetForCreate({
    repo,
    sshTargetGeneration: sshTargetGenerationForConnection(
      operations.state,
      repo ? getRepoSshConnectionId(repo) : undefined
    ),
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
  const setup = applyAutomationLaunchSetupPatch(input)
  const extraAgentArgs = storedExtraAgentArgs(setup.extraAgentArgs)
  const automation: Automation = {
    id: randomUUID(),
    ...(input.creationKey ? { creationKey: input.creationKey } : {}),
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    precheck: normalizeAutomationPrecheck(input.precheck),
    agentId: input.agentId,
    ...(setup.surface ? { surface: setup.surface } : {}),
    ...(extraAgentArgs !== undefined ? { extraAgentArgs } : {}),
    // Prefer authority-local contexts; client-assigned runtime IDs cannot identify this store's host.
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
  assertAutomationExtraAgentArgs(automation)
  operations.state.automations = [...(operations.state.automations ?? []), automation]
  operations.recordCreated()
  operations.flush()
  return automationWithLaunchSetup(automation)
}

export function updateAutomation(
  operations: AutomationDefinitionOperations,
  id: string,
  updates: AutomationUpdateInput,
  options?: {
    expectedOwner?: AutomationOwnerPrecondition
    destination?: AutomationDestination
    resolvedRepo?: Repo
  }
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
  const retainContexts = retainAutomationReselectionContexts(
    operations.state,
    current,
    updates,
    options?.destination,
    projectionContext
  )
  // Ignore undefined values preserved by structuredClone; explicit clears use null.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: filtering removes only undefined entries from the validated patch and retains every remaining field's type.
  const definedUpdates = Object.fromEntries(
    Object.entries(applyAutomationLaunchSetupPatch(updates)).filter(
      ([, value]) => value !== undefined
    )
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
  // Omitted preserves; empty or whitespace clears.
  const extraAgentArgs = Object.hasOwn(definedUpdates, 'extraAgentArgs')
    ? storedExtraAgentArgs(definedUpdates.extraAgentArgs)
    : storedExtraAgentArgs(current.extraAgentArgs)
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
  if (retainContexts && !Object.hasOwn(current, 'sourceContext')) {
    delete merged.sourceContext
  }
  if (extraAgentArgs === undefined) {
    delete merged.extraAgentArgs
  } else {
    merged.extraAgentArgs = extraAgentArgs
  }
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
  if (options?.destination) {
    assertExecutionTargetMatchesDestination(executionTarget, options.destination, workspaceSshPin)
  }
  const updated = applyAutomationExecutionTarget(
    merged,
    executionTarget,
    workspaceSshPinMoved ? undefined : workspaceSshPin
  )
  // Replace the array to invalidate identity-keyed list projections.
  operations.state.automations = operations.state.automations.map((entry) =>
    entry.id === id ? updated : entry
  )
  operations.flush()
  return automationWithLaunchSetup(updated)
}

export { stampLegacyAutomationRunContext } from './automation-context-migration'

export { deleteAutomation } from './automation-definition-removal'
