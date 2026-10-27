import {
  agentChildWorkViewOffersStop,
  type AgentSessionBackgroundTaskStops
} from '../../../shared/agent-child-work-stop-targets'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
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

/** Provider open-work evidence decides admission; stored views only word the refusal. */
export type ConversationCommandChildWork = {
  views: readonly AgentChildWorkView[] | undefined
  open: boolean
}

export type ConversationCommandAdmissionContext = {
  sessionId: string
  fence: number
  journal: StructuredAgentSessionCurrentWorkJournal & {
    snapshot(): Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
  }
  /** Without host projection, assume the generation at fence is live. */
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

/** Cite only visible child work and available Stop controls.
 * At-rest ignores dead-generation turns; at handover, later queued messages wait for this command. */
export function conversationCommandBlocked(
  ctx: ConversationCommandAdmissionContext,
  record: AgentSessionRecord,
  childWork: ConversationCommandChildWork,
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
  // Closed generations’ leftover child work must not block admission.
  if (work.liveFence !== null && childWork.open) {
    return blocked(
      'backgroundTasksRunning',
      stripOffersStop(childWork.views ?? [], ctx.adapter.backgroundTaskStops?.(ctx.sessionId))
        ? 'Stop background tasks before using this command.'
        : 'Wait for background tasks to finish before using this command.'
    )
  }
  // Match the Working indicator; at handover, later messages wait for this command.
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

/** Ask for Stop only when the strip exposes a usable targeted or untargeted control. */
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
