import { randomUUID } from 'node:crypto'
import type {
  Automation,
  AutomationCreateInput,
  AutomationUpdateInput
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeAutomationPrecheck } from '../../../shared/automation-precheck'
import { nextAutomationOccurrenceAfter } from '../../../shared/automation-schedules'
import {
  getAutomationContextsForRepo,
  getAutomationSchedulerOwner,
  normalizeAutomationSessionReuse,
  normalizeAutomationSetupDecisionForWorkspaceMode
} from './automation-context-migration'

export type AutomationDefinitionOperations = {
  state: PersistedState
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
  input: AutomationCreateInput
): Automation {
  const repo = operations.state.repos.find((entry) => entry.id === input.projectId)
  const now = Date.now()
  const executionTargetType = repo?.connectionId ? 'ssh' : 'local'
  const schedulerOwner = getAutomationSchedulerOwner(repo)
  const contexts = getAutomationContextsForRepo(repo, operations.state.projectHostSetups ?? [])
  const automation: Automation = {
    id: randomUUID(),
    name: input.name.trim() || 'Untitled automation',
    prompt: input.prompt,
    precheck: normalizeAutomationPrecheck(input.precheck),
    agentId: input.agentId,
    runContext: input.runContext ?? contexts.runContext,
    sourceContext: input.sourceContext ?? contexts.sourceContext,
    projectId: input.projectId,
    executionTargetType,
    executionTargetId: executionTargetType === 'ssh' ? (repo?.connectionId ?? '') : 'local',
    schedulerOwner,
    workspaceMode: input.workspaceMode,
    workspaceId: input.workspaceMode === 'existing' ? (input.workspaceId ?? null) : null,
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
  updates: AutomationUpdateInput
): Automation {
  const index = (operations.state.automations ?? []).findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error('Automation not found.')
  }
  const current = operations.state.automations[index]
  // Why: the renderer forwards a Partial verbatim, so `{ enabled: undefined }` survives structuredClone
  // and would blank the stored value in the spread below. Explicit clears go through the `null` branches.
  const definedUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined)
  ) as AutomationUpdateInput
  const repoId = updates.projectId ?? current.projectId
  const repo = operations.state.repos.find((entry) => entry.id === repoId)
  const executionTargetType = repo?.connectionId ? 'ssh' : 'local'
  const schedulerOwner = getAutomationSchedulerOwner(repo)
  const contexts = getAutomationContextsForRepo(repo, operations.state.projectHostSetups ?? [])
  const rrule = updates.rrule ?? current.rrule
  const dtstart = updates.dtstart ?? current.dtstart
  const scheduleChanged = updates.rrule !== undefined || updates.dtstart !== undefined
  const workspaceMode = updates.workspaceMode ?? current.workspaceMode
  const updated: Automation = {
    ...current,
    ...definedUpdates,
    name: updates.name !== undefined ? updates.name.trim() || 'Untitled automation' : current.name,
    precheck: Object.hasOwn(definedUpdates, 'precheck')
      ? normalizeAutomationPrecheck(definedUpdates.precheck)
      : normalizeAutomationPrecheck(current.precheck),
    projectId: repoId,
    runContext: Object.hasOwn(definedUpdates, 'runContext')
      ? (definedUpdates.runContext ?? null)
      : updates.projectId !== undefined
        ? contexts.runContext
        : (current.runContext ?? contexts.runContext),
    sourceContext: Object.hasOwn(definedUpdates, 'sourceContext')
      ? (definedUpdates.sourceContext ?? null)
      : updates.projectId !== undefined
        ? contexts.sourceContext
        : (current.sourceContext ?? contexts.sourceContext),
    executionTargetType,
    executionTargetId: executionTargetType === 'ssh' ? (repo?.connectionId ?? '') : 'local',
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
  operations.state.automations[index] = updated
  operations.flush()
  return updated
}

export function deleteAutomation(operations: AutomationDefinitionOperations, id: string): void {
  operations.state.automations = (operations.state.automations ?? []).filter(
    (entry) => entry.id !== id
  )
  operations.state.automationRuns = (operations.state.automationRuns ?? []).filter(
    (entry) => entry.automationId !== id
  )
  operations.flush()
}
