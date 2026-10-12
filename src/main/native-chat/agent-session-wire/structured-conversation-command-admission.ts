import {
  agentChildWorkViewOffersStop,
  type AgentSessionBackgroundTaskStops
} from '../../../shared/agent-child-work-stop-targets'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { agentSessionCurrentContextRows } from '../../../shared/agent-session-context-clear'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  contextStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
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
  journal: StructuredAgentSessionCurrentWorkJournal & {
    snapshot(): Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  }
  /** The host's projection of current work; without one, the generation at `fence` is live. */
  currentWork?: () => StructuredAgentSessionCurrentWork | null
  adapter: Pick<StructuredAgentSessionAdapter, 'backgroundTaskStops'>
}

function blocked(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): AgentSessionWireRefusal {
  return refuse('agent_session_operation_invalid', { reason }, message)
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
  const { items, submissions } = agentSessionCurrentContextRows(
    ctx.journal.snapshot().items,
    ctx.journal.submissions()
  )
  if (record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded') {
    return blocked('rewindUnconfirmed', 'agent_session_rewind:outcome-unknown')
  }
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return blocked('handoffInFlight', 'Wait for the session handoff to finish.')
  }
  // What is current is the host projection's to say: an ended generation's turn, prompt or send
  // refuses nothing.
  const work = contextStructuredAgentSessionCurrentWork(ctx)
  if (admission !== 'at-rest' && work.activeTurnId()) {
    return blocked('turnActive', 'Wait for the current turn to finish before using this command.')
  }
  if (
    items.some(
      (item) =>
        (item.body.kind === 'approval' || item.body.kind === 'question') &&
        item.body.resolution.state === 'pending' &&
        work.isCurrentItem(item.itemId)
    )
  ) {
    return blocked(
      'promptPending',
      'Resolve the pending question or approval before using this command.'
    )
  }
  // The same liveness fold the strip's monitoring indicator reads: settled rows block nothing.
  // Child records are the live generation's: its adapter ends them on every close, so with no
  // generation live, any still running are an ended one's leftovers and hold nothing.
  if (work.liveFence !== null && agentChildWorkLiveness(childWork) !== null) {
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
    submissions.some(
      (entry) =>
        !(admission === 'handover' && isQueuedAgentJournalSubmission(entry)) && work.owesSend(entry)
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
