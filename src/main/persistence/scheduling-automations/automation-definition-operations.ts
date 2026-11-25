import { automationCreateIdentity } from './automation-create-identity'
import { getRepoSshConnectionId } from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import { findAutomationRepoForWrite } from '../../../shared/automations/ownership/automation-repo-target'
import {
  applyAutomationLaunchSetupPatch,
  automationWithLaunchSetup
} from '../../../shared/automations/launch/automation-launch-setup'
import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput
} from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { normalizeAutomationPrecheck } from '../../../shared/automations/launch/automation-precheck'
import {
  assertAutomationExtraAgentArgs,
  storedExtraAgentArgs
} from '../../../shared/automations/launch/automation-extra-agent-args-record'
import { settleAutomationTriggers } from '../../webhooks/webhook-rule-check'
import { deriveAutomationExecutionTargetForCreate } from '../../../shared/automations/ownership/automation-execution-target'
import {
  assertAutomationDestination,
  assertExecutionTargetMatchesDestination,
  type AutomationDestination
} from '../../../shared/automations/ownership/automation-owner-precondition'
import {
  getAutomationContextsForRepo,
  getAutomationSchedulerOwner,
  applyAutomationSetupTrust,
  normalizeAutomationSessionReuse,
  normalizeAutomationSetupDecisionForWorkspaceMode
} from './automation-context-migration'
import { firstAutomationRunAt } from './automation-schedule-operations'
import { botAndTriggerFields } from './automation-bot-trigger-fields'
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
  // id: chosen by a caller that registered it elsewhere first (a webhook's mint).
  options?: { destination?: AutomationDestination; id?: string; resolvedRepo?: Repo }
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
  // v1 bots live on this computer and have no project to derive a host from.
  const executionTarget = input.bot
    ? ({ executionTargetType: 'local', executionTargetId: 'local' } as const)
    : deriveAutomationExecutionTargetForCreate({
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
  const updateCodexBeforeRun =
    input.agentId === 'codex' && !input.bot && input.updateCodexBeforeRun === true
  const automation: Automation = {
    id: options?.id ?? randomUUID(),
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
    ...(updateCodexBeforeRun ? { updateCodexBeforeRun: true } : {}),
    // Prefer authority-local contexts; client-assigned runtime IDs cannot identify this store's host.
    runContext: contexts.runContext ?? input.runContext ?? null,
    sourceContext: contexts.sourceContext ?? input.sourceContext ?? null,
    ...botAndTriggerFields(input),
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
    reuseSession:
      input.workspaceMode === 'existing' && !updateCodexBeforeRun && input.reuseSession === true,
    timezone: input.timezone,
    rrule: input.rrule,
    dtstart: input.dtstart,
    enabled: input.enabled ?? true,
    nextRunAt: firstAutomationRunAt(input, operations.storageAuthority, now),
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: input.missedRunGraceMinutes ?? 720,
    createdAt: now,
    updatedAt: now
  }
  applyAutomationSetupTrust(automation, input)
  assertAutomationExtraAgentArgs(automation)
  settleAutomationTriggers(automation)
  operations.state.automations = [...(operations.state.automations ?? []), automation]
  operations.recordCreated()
  operations.flush()
  return automationWithLaunchSetup(automation)
}

export { updateAutomation } from './automation-definition-update'
export { deleteAutomation } from './automation-definition-removal'
