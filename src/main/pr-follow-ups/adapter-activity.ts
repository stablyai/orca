import type { FollowUpAction, FollowUpWorking } from '../../shared/pr-follow-ups/contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'

export async function followUpSessionLive(
  runtime: OrcaRuntimeService,
  action: FollowUpAction
): Promise<boolean | 'unknown'> {
  if (action.sessionId) {
    const record = (await runtime.openAgentSessionRecordStore()).getConversation(action.sessionId)
    if (record?.location.workspaceId !== action.worktreeId) {
      return 'unknown'
    }
    if (
      record.ownerObservation.claimStatus === 'released' &&
      record.ownerObservation.deathEvidence
    ) {
      return false
    }
    return record.ownerObservation.claimStatus === 'live' &&
      !record.ownerObservation.unreconciled &&
      record.ownerObservation.leaseDeadlineAt > Date.now()
      ? true
      : 'unknown'
  }
  if (!action.terminalHandle) {
    return 'unknown'
  }
  const result = await runtime.listTerminals(undefined, 1, {
    handles: [action.terminalHandle],
    requireFreshPtyLiveness: true
  })
  const terminal = result.terminals.find(
    (row) => row.handle === action.terminalHandle && row.worktreeId === action.worktreeId
  )
  return terminal?.exitCause || terminal?.verdict === 'exited'
    ? false
    : terminal?.verdict === 'live'
      ? true
      : 'unknown'
}

export function followUpSessionWorking(
  runtime: OrcaRuntimeService,
  action: FollowUpAction
): FollowUpWorking {
  if (action.sessionId) {
    const summary = getStructuredAgentSessionHost()?.readStatusSummary(action.sessionId)
    if (!summary || summary.workspaceId !== action.worktreeId || summary.status === null) {
      return 'unknown'
    }
    return {
      working: summary.status === 'working' || summary.status === 'attention',
      at: summary.statusStartedAt ?? summary.updatedAt
    }
  }
  if (!action.paneKey) {
    return 'unknown'
  }
  const row = runtime.agentTransitions.latestRow(action.paneKey)
  if (!row || row.worktreeId !== action.worktreeId || row.restoredUnconfirmed || row.isReplay) {
    return 'unknown'
  }
  const phase = runtime.agentTransitions.phaseOf(action.paneKey)
  return phase === 'rest'
    ? 'unknown'
    : { working: phase !== 'done', at: row.evidenceObservedAt ?? row.receivedAt }
}
