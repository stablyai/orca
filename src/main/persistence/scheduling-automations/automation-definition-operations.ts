import { retainAutomationReselectionContexts } from './automation-host-reselection'
import { automationCreateIdentity } from './automation-create-identity'
import { getRepoSshConnectionId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { findAutomationRepoForWrite } from '../../../shared/automations/ownership/automation-repo-target'
import {
  applyAutomationLaunchSetupPatch,
  automationWithLaunchSetup
} from '../../../shared/automations/launch/automation-launch-setup'
import { automationCanonicalLaunchSetup } from '../../../shared/automations/launch/automation-canonical-launch-setup'
import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeAutomationPrecheck } from '../../../shared/automations/launch/automation-precheck'
import {
  assertAutomationExtraAgentArgs,
  storedExtraAgentArgs
} from '../../../shared/automations/launch/automation-extra-agent-args-record'
import { nextAutomationOccurrenceAfter } from '../../../shared/automations/scheduling/automation-schedule-occurrences'
import {
  applyAutomationExecutionTarget,
  deriveAutomationExecutionTargetForCreate,
  deriveAutomationExecutionTargetForUpdate
} from '../../../shared/automations/ownership/automation-execution-target'
import {
  assertAutomationDestination,
  assertAutomationOwnerFence,
  assertAutomationWorkspaceModePrecondition,
  assertExecutionTargetMatchesDestination,
  type AutomationDestination,
  type AutomationUpdatePreconditions
} from '../../../shared/automations/ownership/automation-owner-precondition'
import {
  getAutomationContextsForRepo,
  automationContextAfterUpdate,
  getAutomationSchedulerOwner,
  applyAutomationSetupTrust,
  normalizeAutomationSessionReuse,
  normalizeAutomationSetupDecisionForWorkspaceMode
} from './automation-context-migration'
import { refuseManagedOrcadHost } from '../../automations/ownership/orcad-fenced-automation'
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
  refuseManagedOrcadHost(operations.state, executionTarget, workspaceSshPin)
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
    ...automationCreateIdentity(input),
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    precheck: normalizeAutomationPrecheck(input.precheck),
    agentId: input.agentId,
    ...(setup.surface ? { surface: setup.surface } : {}),
    ...(setup.launchPreferences !== undefined
      ? { launchPreferences: setup.launchPreferences }
      : {}),
    ...(setup.agentArgs !== undefined ? { agentArgs: setup.agentArgs } : {}),
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
  applyAutomationSetupTrust(automation, input)
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
  options?: AutomationUpdatePreconditions & { resolvedRepo?: Repo }
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

export { deleteAutomation } from './automation-definition-removal'
