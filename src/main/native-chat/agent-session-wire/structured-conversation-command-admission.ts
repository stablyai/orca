import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

/**
 * Why a conversation command may not run now; null when it may.
 *
 * `at-rest`: a command accepted with no child running. A running turn on record then belongs to a
 * dead generation, which the start before handover sweeps, so it refuses nothing yet.
 * `handover`: the command is the oldest queued message, and those queued behind it wait for it.
 */
export function conversationCommandBlocked(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'adapter' | 'sessionId' | 'fence'>,
  record: AgentSessionRecord,
  admission?: 'at-rest' | 'handover'
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
  // An older build's compaction record belongs to a child this host no longer runs.
  if (
    record.conversationCommand?.command === 'clear' &&
    record.conversationCommand.state === 'unknown' &&
    record.conversationCommand.phase === 'prepared'
  ) {
    return 'The previous conversation operation is unconfirmed.'
  }
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return 'Wait for the session handoff to finish.'
  }
  if (admission !== 'at-rest' && activeStructuredAgentSessionTurnId(items)) {
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
  const backgroundTasks = ctx.adapter.backgroundTaskState?.(ctx.sessionId)
  if (backgroundTasks?.state === 'monitoring') {
    // Only ask for a stop the host can actually perform. A provider that
    // exposes neither a targeted nor an untargeted stop would otherwise leave
    // the command refused behind an instruction nobody can follow.
    return backgroundTasks.supportsTaskStop || backgroundTasks.supportsStopAll !== false
      ? 'Stop background tasks before using this command.'
      : 'Wait for background tasks to finish before using this command.'
  }
  if (
    ctx.journal.submissions().some(
      (entry) =>
        (entry.dispatchState === 'pending' &&
          !(admission === 'handover' && isQueuedAgentJournalSubmission(entry))) ||
        // Doubt left by an earlier child is not this one's work in flight.
        (entry.dispatchState === 'unknown' && entry.recovered !== true && entry.fence === ctx.fence)
    )
  ) {
    return 'Resolve pending or unconfirmed messages before using this command.'
  }
  return null
}
