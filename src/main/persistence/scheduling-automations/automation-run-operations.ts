import { randomUUID } from 'node:crypto'
import { isFinalAutomationRunStatus } from '../../../shared/automations-types'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun,
  AutomationRunsPage,
  AutomationRunTrigger
} from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  nextAutomationRunNumber,
  pruneAutomationRuns
} from '../../../shared/automation-run-retention'
import {
  compareAutomationRunsNewestFirst,
  paginateAutomationRuns
} from '../../../shared/automation-run-cursor'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import {
  normalizeAutomationPrecheckResult,
  normalizeAutomationRunOutputSnapshot,
  normalizeAutomationRunTerminalPaneKey,
  normalizeAutomationRunTerminalPtyId,
  normalizeAutomationRunWorkspaceDisplayName
} from './automation-context-migration'

export type AutomationRunOperations = {
  state: PersistedState
  flush: () => void
  recordAutomationRunsMutation?: (runs: readonly AutomationRun[]) => void
  recordManualRun: () => void
  getWorkspaceDisplayName: (workspaceId: string | null | undefined) => string | null
}

function touchAutomation(state: PersistedState, automationId: string, now: number): void {
  if (!state.automations.some((entry) => entry.id === automationId)) {
    return
  }
  state.automations = state.automations.map((entry) =>
    entry.id === automationId ? { ...entry, lastRunAt: now, updatedAt: now } : entry
  )
}

function sortedAutomationRuns(state: PersistedState, automationId?: string): AutomationRun[] {
  const runs = state.automationRuns ?? []
  return [...(automationId ? runs.filter((run) => run.automationId === automationId) : runs)]
    .map((run) => ({
      ...run,
      precheckResult: normalizeAutomationPrecheckResult(run.precheckResult)
    }))
    .sort(compareAutomationRunsNewestFirst)
}

export function listAutomationRuns(state: PersistedState, automationId?: string): AutomationRun[] {
  return sortedAutomationRuns(state, automationId)
}

export function listAutomationRunsPage(
  state: PersistedState,
  automationId: string | undefined,
  limit = 100,
  cursor?: string
): AutomationRunsPage {
  return paginateAutomationRuns(sortedAutomationRuns(state, automationId), limit, cursor)
}

export function createAutomationRun(
  operations: AutomationRunOperations,
  automation: Automation,
  scheduledFor: number,
  trigger: AutomationRunTrigger = 'scheduled'
): AutomationRun {
  const existing = (operations.state.automationRuns ?? []).find(
    (run) => run.automationId === automation.id && run.scheduledFor === scheduledFor
  )
  if (existing) {
    return existing
  }
  const now = Date.now()
  // Retention prunes history, so derive the next ordinal from the newest survivor rather than count.
  const runNumber = nextAutomationRunNumber(
    (operations.state.automationRuns ?? []).filter((run) => run.automationId === automation.id)
  )
  const run: AutomationRun = {
    id: randomUUID(),
    automationId: automation.id,
    runNumber,
    runContext: automation.runContext ?? null,
    sourceContext: automation.sourceContext ?? null,
    title: `${automation.name} run ${runNumber}`,
    scheduledFor,
    status: 'pending',
    trigger,
    workspaceId: automation.workspaceId,
    workspaceDisplayName: operations.getWorkspaceDisplayName(automation.workspaceId),
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: now
  }
  operations.state.automationRuns = pruneAutomationRuns([
    ...(operations.state.automationRuns ?? []),
    run
  ])
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns ?? [])
  if (trigger === 'manual') {
    operations.recordManualRun()
  }
  operations.flush()
  return run
}

export function recordRepeatedAutomationSkip(
  operations: AutomationRunOperations,
  automationId: string,
  error: string,
  scheduledFor: number
): AutomationRun | null {
  const runs = operations.state.automationRuns ?? []
  const latest = runs
    .filter((run) => run.automationId === automationId)
    .reduce<AutomationRun | null>(
      (newest, run) => (!newest || run.createdAt > newest.createdAt ? run : newest),
      null
    )
  if (
    !latest ||
    latest.status !== 'skipped_unavailable' ||
    latest.trigger !== 'scheduled' ||
    latest.error !== error
  ) {
    return null
  }
  if ((latest.lastOccurrenceAt ?? latest.scheduledFor) === scheduledFor) {
    return latest
  }
  const now = Date.now()
  const updated: AutomationRun = {
    ...latest,
    occurrenceCount: (latest.occurrenceCount ?? 1) + 1,
    lastOccurrenceAt: scheduledFor
  }
  // Replace the array to invalidate identity-keyed list projections.
  operations.state.automationRuns = runs.map((run) => (run.id === latest.id ? updated : run))
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  touchAutomation(operations.state, automationId, now)
  operations.flush()
  return updated
}

/** Rewrites of the same error (e.g. usage writes) keep its code; a different error drops a stale one. */
function resultErrorCodeFields(
  result: AutomationDispatchResult,
  previous: AutomationRun
): Pick<AutomationRun, 'errorCode' | 'errorParams'> {
  const source = result.errorCode
    ? result
    : result.error && result.error === previous.error
      ? previous
      : null
  if (!result.error || !source?.errorCode) {
    return {}
  }
  return {
    errorCode: source.errorCode,
    ...(source.errorParams ? { errorParams: source.errorParams } : {})
  }
}

export function updateAutomationRun(
  operations: AutomationRunOperations,
  result: AutomationDispatchResult
): AutomationRun {
  const index = (operations.state.automationRuns ?? []).findIndex(
    (entry) => entry.id === result.runId
  )
  if (index === -1) {
    throw new Error('Automation run not found.')
  }
  const now = Date.now()
  const previous = operations.state.automationRuns[index]
  const { errorCode: _code, errorParams: _params, ...current } = previous
  const workspaceId = result.workspaceId ?? current.workspaceId
  const workspaceDisplayName = Object.hasOwn(result, 'workspaceDisplayName')
    ? normalizeAutomationRunWorkspaceDisplayName(result.workspaceDisplayName ?? null)
    : null
  const updated: AutomationRun = {
    ...current,
    status: result.status,
    sessionKind: result.sessionKind ?? current.sessionKind,
    chatSessionId: Object.hasOwn(result, 'chatSessionId')
      ? (result.chatSessionId ?? null)
      : current.chatSessionId,
    workspaceId,
    workspaceDisplayName:
      workspaceDisplayName ??
      normalizeAutomationRunWorkspaceDisplayName(current.workspaceDisplayName ?? null) ??
      operations.getWorkspaceDisplayName(workspaceId),
    terminalSessionId: Object.hasOwn(result, 'terminalSessionId')
      ? (result.terminalSessionId ?? null)
      : current.terminalSessionId,
    terminalPaneKey: Object.hasOwn(result, 'terminalPaneKey')
      ? normalizeAutomationRunTerminalPaneKey(result.terminalPaneKey)
      : normalizeAutomationRunTerminalPaneKey(current.terminalPaneKey),
    terminalPtyId: Object.hasOwn(result, 'terminalPtyId')
      ? normalizeAutomationRunTerminalPtyId(result.terminalPtyId)
      : normalizeAutomationRunTerminalPtyId(current.terminalPtyId),
    outputSnapshot: Object.hasOwn(result, 'outputSnapshot')
      ? normalizeAutomationRunOutputSnapshot(result.outputSnapshot)
      : normalizeAutomationRunOutputSnapshot(current.outputSnapshot),
    precheckResult: Object.hasOwn(result, 'precheckResult')
      ? normalizeAutomationPrecheckResult(result.precheckResult)
      : normalizeAutomationPrecheckResult(current.precheckResult),
    usage: Object.hasOwn(result, 'usage') ? (result.usage ?? null) : (current.usage ?? null),
    error: result.error ?? null,
    ...resultErrorCodeFields(result, previous),
    startedAt: current.startedAt ?? now,
    dispatchedAt:
      result.status === 'dispatched' ? (result.dispatchedAt ?? now) : current.dispatchedAt
  }
  // Replace the array to invalidate identity-keyed list projections.
  operations.state.automationRuns = operations.state.automationRuns.map((run) =>
    run.id === result.runId ? updated : run
  )
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  if (!isFinalAutomationRunStatus(current.status) && isFinalAutomationRunStatus(updated.status)) {
    // Final runs stop pinning workspace metadata (#17775).
    invalidateLocalWorktreeMetadataPruneInputs()
  }
  touchAutomation(operations.state, updated.automationId, now)
  operations.flush()
  return updated
}

export function snapshotAutomationRunWorkspaceDisplayName(
  operations: AutomationRunOperations,
  target: HostWorktreeTarget,
  displayName: string
): number {
  const normalizedDisplayName = normalizeAutomationRunWorkspaceDisplayName(displayName)
  if (!normalizedDisplayName) {
    return 0
  }
  // Folder UUIDs are globally unique even when the run's project host differs.
  const hostScoped = parseWorkspaceKey(target.id)?.type !== 'folder'
  let updatedCount = 0
  operations.state.automationRuns = (operations.state.automationRuns ?? []).map((run) => {
    if (
      run.workspaceId !== target.id ||
      // Match same-ID runs by host when their context provides proof.
      (hostScoped && run.runContext && run.runContext.hostId !== target.hostId) ||
      run.workspaceDisplayName === normalizedDisplayName
    ) {
      return run
    }
    updatedCount += 1
    return { ...run, workspaceDisplayName: normalizedDisplayName }
  })
  if (updatedCount > 0) {
    operations.recordAutomationRunsMutation?.(operations.state.automationRuns ?? [])
    operations.flush()
  }
  return updatedCount
}
