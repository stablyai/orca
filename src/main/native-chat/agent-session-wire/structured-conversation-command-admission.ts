import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

export function conversationCommandBlocked(
  ctx: AgentSessionTurnContext,
  record: AgentSessionRecord
): string | null {
  const items = ctx.journal.snapshot().items
  if (record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded') {
    return 'agent_session_rewind:outcome-unknown'
  }
  if (
    record.conversationCommand?.command === 'clear' &&
    record.conversationCommand.phase === 'committed' &&
    record.conversationCommand.replacementSessionId
  ) {
    return 'This conversation has been cleared. Open the current conversation to continue.'
  }
  if (
    record.conversationCommand?.state === 'unknown' &&
    record.conversationCommand.phase === 'prepared'
  ) {
    return 'The previous conversation operation is unconfirmed.'
  }
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return 'Wait for the session handoff to finish.'
  }
  if (activeStructuredAgentSessionTurnId(items)) {
    return 'Wait for the current turn to finish before using this command.'
  }
  if (
    items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending'
    )
  ) {
    return 'Resolve the pending question or approval before using this command.'
  }
  if (ctx.adapter.backgroundTaskState?.(ctx.sessionId)?.state === 'monitoring') {
    return 'Stop background tasks before using this command.'
  }
  if (
    ctx.journal
      .submissions()
      .some((entry) => entry.dispatchState === 'pending' || entry.dispatchState === 'unknown')
  ) {
    return 'Resolve pending or unconfirmed messages before using this command.'
  }
  return null
}
