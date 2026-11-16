import {
  agentChildWorkViewOffersStop,
  type AgentSessionBackgroundTaskStops
} from '../../../../shared/agent-status/child-work/agent-child-work-stop-targets'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionCapabilities } from '../../../../shared/agent-session/agent-session-capabilities'
import type { AgentChildWorkView } from '../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import { readContextStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'

import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import {
  refuse,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRefusalReason } from '../../../../shared/agent-session/failures/agent-session-refusal-details'

/** Provider open-work evidence decides admission; stored views only word the refusal. */
export type ConversationCommandChildWork = {
  views: readonly AgentChildWorkView[] | undefined
  open: boolean
}

/** Null where the agent compacts beside background tasks, so they don't hold /compact. */
export function compactionChildWork(
  capabilities: Pick<AgentSessionCapabilities, 'compactBesideBackgroundTasks'> | null | undefined,
  childWork: () => ConversationCommandChildWork
): ConversationCommandChildWork | null {
  return capabilities?.compactBesideBackgroundTasks ? null : childWork()
}

export type ConversationCommandAdmissionContext = {
  sessionId: string
  fence: number
  journal: AgentSessionJournal
  readWork?: JournalWorkReader
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
export async function conversationCommandBlocked(
  ctx: ConversationCommandAdmissionContext,
  record: AgentSessionRecord,
  childWork: ConversationCommandChildWork | null,
  admission?: 'at-rest' | 'handover'
): Promise<AgentSessionWireRefusal | null> {
  if (record.rewind?.phase === 'prepared' || record.rewind?.phase === 'provider-succeeded') {
    return blocked('rewindUnconfirmed', 'agent_session_rewind:outcome-unknown')
  }
  if (record.lease.handoffStage || record.lease.handoffOperationId) {
    return blocked('handoffInFlight', 'Wait for the session handoff to finish.')
  }
  const { state: work } = await readContextStructuredAgentSessionWork(ctx, { kind: 'state' })
  if (admission !== 'at-rest' && work.activeTurn) {
    return blocked('turnActive', 'Wait for the current turn to finish before using this command.')
  }
  if (work.commandAdmission.promptPending) {
    return blocked(
      'promptPending',
      'Resolve the pending question or approval before using this command.'
    )
  }
  // Closed generations’ leftover child work must not block admission.
  if (work.liveFence !== null && childWork?.open) {
    return blocked(
      'backgroundTasksRunning',
      stripOffersStop(childWork.views ?? [], ctx.adapter.backgroundTaskStops?.(ctx.sessionId))
        ? 'Stop background tasks before using this command.'
        : 'Wait for background tasks to finish before using this command.'
    )
  }
  // Match the Working indicator; at handover, later messages wait for this command.
  if (
    admission === 'handover'
      ? work.commandAdmission.handoverOwesSend
      : work.commandAdmission.owesSend
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
