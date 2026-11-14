import {
  orchestrationMailNotice,
  USER_MESSAGE_SOURCE
} from '../../../../shared/agent-session/agent-session-message-source'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalInputOrder } from '../input-order/journal-input-order'

export type UnsentSendHold =
  /** Accepted by an earlier process. */
  | { cause: 'hostRestarted' }
  /** Restrict settlement when only part of a close completed. */
  | { cause: 'chatClosed'; which?: (submission: AgentJournalSubmission) => boolean }

type UnsentSendSelection = {
  hold: UnsentSendHold
  /** Failed initialization proves these handed-over sends did not run. */
  unrun?: true | ((submission: AgentJournalSubmission) => boolean)
}

export function journalUnsentSendBatch(
  journal: {
    inputOrder: Pick<JournalInputOrder, 'recoverableSubmissions' | 'recoveryPending'>
    itemBody: (id: string) => AgentJournalItemBody | null
  },
  input: UnsentSendSelection
): { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[] {
  return journal.inputOrder
    .recoverableSubmissions()
    .filter((entry) =>
      input.unrun
        ? isUnansweredHandedOverSubmission(entry) && (input.unrun === true || input.unrun(entry))
        : isQueuedAgentJournalSubmission(entry) &&
          (input.hold.cause === 'hostRestarted'
            ? journal.inputOrder.recoveryPending(entry.clientMessageId)
            : (input.hold.which?.(entry) ?? true))
    )
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
    .map((submission) => ({
      submission,
      body: unsentSendKeptAsCard(
        submission,
        journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
      )
    }))
}

/** A linked attempt returns its own row; host-derived work is not replayed after restart. */
export function unsentSendKeptAsCard(
  submission: Pick<AgentJournalSubmission, 'queuedMessageId' | 'source' | 'origin'>,
  body: AgentJournalItemBody | null
): AgentJournalMessageItem | null {
  if (submission.queuedMessageId !== undefined || body?.kind !== 'message') {
    return null
  }
  const { source } = submission
  // Unknown source kinds must never default to personal sends.
  const persons =
    source?.kind === USER_MESSAGE_SOURCE.kind ||
    // Before source existed, client origin identified personal sends.
    (source === undefined && submission.origin === 'client')
  return persons || body.command || orchestrationMailNotice(body.from) ? body : null
}

/** Failed initialization proves unanswered handed-over sends never ran. */
export function isUnansweredHandedOverSubmission(
  entry: Pick<
    AgentJournalSubmission,
    'handoverRecorded' | 'dispatchState' | 'handedOverAt' | 'recovered'
  >
): boolean {
  return (
    !isQueuedAgentJournalSubmission(entry) &&
    (entry.dispatchState === 'pending' ||
      (entry.dispatchState === 'unknown' && entry.recovered !== true))
  )
}
