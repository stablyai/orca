import { agentChildWorkViewOffersStop } from '../../../shared/agent-child-row-model'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentChildWorkLiveness } from '../../../shared/agent-status-child-work-liveness'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  AgentSessionBackgroundTaskStops,
  StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'

/** What admission reads of a turn: the journal, and only the provider's stop capability. */
export type ConversationCommandAdmissionContext = {
  sessionId: string
  journal: {
    snapshot(): Pick<ReturnType<AgentSessionJournal['snapshot']>, 'items'>
    submissions: AgentSessionJournal['submissions']
  }
  adapter: Pick<StructuredAgentSessionAdapter, 'backgroundTaskStops'>
}

/** `childWork` is the session's child records as the chat strip reads them: a refusal may only
 *  cite work the strip lists, and ask for a stop only when the strip offers one. */
export function conversationCommandBlocked(
  ctx: ConversationCommandAdmissionContext,
  record: AgentSessionRecord,
  childWork: readonly AgentChildWorkView[] | undefined
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
  // The same liveness fold the strip's monitoring indicator reads: settled rows block nothing.
  if (agentChildWorkLiveness(childWork) !== null) {
    return stripOffersStop(childWork ?? [], ctx.adapter.backgroundTaskStops?.(ctx.sessionId))
      ? 'Stop background tasks before using this command.'
      : 'Wait for background tasks to finish before using this command.'
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
