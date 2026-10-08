import {
  agentChildWorkViewOffersStop,
  type AgentSessionBackgroundTaskStops
} from '../../../shared/agent-child-work-stop-targets'
import type { AgentSessionConversationCommandRecord } from '../../../shared/agent-session-conversation-command'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import { isUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-unanswered-dispatch'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  refuse,
  type AgentSessionRefusalReason,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'

/** What admission reads of a turn: the journal, its fence, and only the provider's stop capability. */
export type ConversationCommandAdmissionContext = {
  sessionId: string
  fence: number
  journal: {
    snapshot(): Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
    submissions: AgentSessionJournal['submissions']
  }
  adapter: Pick<StructuredAgentSessionAdapter, 'backgroundTaskStops'>
}

function blocked(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): AgentSessionWireRefusal {
  return refuse('agent_session_operation_invalid', { reason }, message)
}

/**
 * The /clear this caller committed on a conversation whose tab has since moved to its replacement.
 * A /clear it presses there again asks for what that one already did; any other caller, or a
 * cleared conversation opened again from history, reads `conversationCleared` instead.
 */
export function committedClearOfCaller(
  record: AgentSessionRecord | null,
  callerKey: string,
  tabId: string | null
): AgentSessionConversationCommandRecord | null {
  const command = record?.conversationCommand
  return command?.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId &&
    command.callerKey === callerKey &&
    tabId === null
    ? command
    : null
}

export function conversationCommandInFlight(): AgentSessionWireRefusal {
  return blocked('conversationCommandInFlight', 'Wait for the conversation operation to finish.')
}

/**
 * Why a conversation command may not run now; null when it may.
 *
 * `childWork` is the session's child records as the chat strip reads them: a refusal may only
 * cite work the strip lists, and ask for a stop only when the strip offers one.
 * `at-rest`: a command accepted with no child running. A running turn on record then belongs to a
 * dead generation, which the start before handover sweeps, so it refuses nothing yet.
 * `handover`: the command is the oldest queued message, and those queued behind it wait for it.
 */
export function conversationCommandBlocked(
  ctx: ConversationCommandAdmissionContext,
  record: AgentSessionRecord,
  childWork: readonly AgentChildWorkView[] | undefined,
  admission?: 'at-rest' | 'handover'
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
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return blocked('handoffInFlight', 'Wait for the session handoff to finish.')
  }
  if (admission !== 'at-rest' && activeStructuredAgentSessionTurnId(items)) {
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
  // The same liveness fold the strip's monitoring indicator reads: settled rows block nothing.
  if (agentChildWorkLiveness(childWork) !== null) {
    return blocked(
      'backgroundTasksRunning',
      stripOffersStop(childWork ?? [], ctx.adapter.backgroundTaskStops?.(ctx.sessionId))
        ? 'Stop background tasks before using this command.'
        : 'Wait for background tasks to finish before using this command.'
    )
  }
  // The Working indicator's own rule, so "unsettled" is exactly what the chat shows as working.
  // At handover the queued messages are those behind this command, waiting for it.
  if (
    ctx.journal
      .submissions()
      .some(
        (entry) =>
          !(admission === 'handover' && isQueuedAgentJournalSubmission(entry)) &&
          isUnansweredStructuredAgentSessionDispatch(entry, ctx.fence)
      )
  ) {
    return blocked(
      'messagesUnsettled',
      'Resolve pending or unconfirmed messages before using this command.'
    )
  }
  return null
}

/** The strip's own stop controls: a per-row stop where the provider can target one, else its
 *  single untargeted stop. Asking for a stop it does not render names a control nobody can use. */
function stripOffersStop(
  childWork: readonly AgentChildWorkView[],
  stops: AgentSessionBackgroundTaskStops | undefined
): boolean {
  if (!stops) {
    return false
  }
  return stops.supportsTaskStop
    ? childWork.some(agentChildWorkViewOffersStop)
    : stops.supportsStopAll
}
