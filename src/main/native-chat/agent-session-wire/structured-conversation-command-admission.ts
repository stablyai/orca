import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import {
  refuse,
  type AgentSessionRefusalCause,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'

function blocked(cause: AgentSessionRefusalCause, message: string): AgentSessionWireRefusal {
  return refuse('agent_session_operation_invalid', cause, message)
}

export function conversationCommandBlocked(
  ctx: AgentSessionTurnContext,
  record: AgentSessionRecord
): AgentSessionWireRefusal | null {
  const items = ctx.journal.snapshot().items
  if (record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded') {
    return blocked('rewindUnconfirmed', 'agent_session_rewind:outcome-unknown')
  }
  if (
    record.conversationCommand?.command === 'clear' &&
    record.conversationCommand.phase === 'committed' &&
    record.conversationCommand.replacementSessionId
  ) {
    return blocked(
      'conversationCleared',
      'This conversation has been cleared. Open the current conversation to continue.'
    )
  }
  if (
    record.conversationCommand?.state === 'unknown' &&
    record.conversationCommand.phase === 'prepared'
  ) {
    return blocked(
      'conversationCommandUnconfirmed',
      'The previous conversation operation is unconfirmed.'
    )
  }
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return blocked('handoffInFlight', 'Wait for the session handoff to finish.')
  }
  if (activeStructuredAgentSessionTurnId(items)) {
    return blocked('turnActive', 'Wait for the current turn to finish before using this command.')
  }
  if (
    items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
  ) {
    return blocked(
      'promptPending',
      'Resolve the pending question or approval before using this command.'
    )
  }
  const backgroundTasks = ctx.adapter.backgroundTaskState?.(ctx.sessionId)
  if (backgroundTasks?.state === 'monitoring') {
    // Only ask for a stop the host can actually perform. A provider that
    // exposes neither a targeted nor an untargeted stop would otherwise leave
    // the command refused behind an instruction nobody can follow.
    return blocked(
      'backgroundTasksRunning',
      backgroundTasks.supportsTaskStop || backgroundTasks.supportsStopAll !== false
        ? 'Stop background tasks before using this command.'
        : 'Wait for background tasks to finish before using this command.'
    )
  }
  if (
    ctx.journal.submissions().some(
      (entry) =>
        entry.dispatchState === 'pending' ||
        // Doubt left by an earlier child is not this one's work in flight.
        (entry.dispatchState === 'unknown' && entry.recovered !== true && entry.fence === ctx.fence)
    )
  ) {
    return blocked(
      'messagesUnsettled',
      'Resolve pending or unconfirmed messages before using this command.'
    )
  }
  return null
}
