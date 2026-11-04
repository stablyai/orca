import type { AgentSessionSendResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { CommandReceiptRead } from '../agent-session-journal/command-receipt-table'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { dispatchWasWithdrawn } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'

type SendAnswerJournal = Pick<AgentSessionJournal, 'submission' | 'inputOrder'> & {
  queuedMessages: Pick<AgentSessionJournal['queuedMessages'], 'get'>
}

/** A card whose row is gone answers from its latest handoff, found by key, never by a history scan. */
function latestHandoff(
  journal: SendAnswerJournal,
  messageId: string
): AgentJournalSubmission | undefined {
  let latest: AgentJournalSubmission | undefined
  for (const handoff of journal.inputOrder.linkedTo(messageId)) {
    if ((handoff.submittedSequence ?? 0) >= (latest?.submittedSequence ?? 0)) {
      latest = handoff
    }
  }
  return latest
}

/** Refused conversions replay as returned cards, avoiding duplicate Retry rows; null means never queued. */
export function queuedSendAnswer(
  journal: SendAnswerJournal,
  clientMessageId: string
): AgentSessionSendResult | null {
  const draft = journal.queuedMessages.get(clientMessageId)
  if (draft) {
    const consumed =
      draft.state === 'dispatched' && draft.consumedAs !== null
        ? journal.submission(draft.consumedAs)
        : undefined
    return consumed
      ? { clientMessageId, submission: { ...consumed } }
      : {
          clientMessageId,
          queued: { messageId: draft.messageId, position: draft.position, state: draft.state }
        }
  }
  // Missing cards with rejected handoffs were deleted; replay withdrawn rather than a refused send.
  const handoff = latestHandoff(journal, clientMessageId)
  if (handoff?.dispatchState === 'rejected') {
    return {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 0, state: 'withdrawn' }
    }
  }
  return handoff ? { clientMessageId, submission: { ...handoff } } : null
}

/** What became of one send, answered by the host that admitted it. */
export type StructuredSendAnswer =
  /** Still the chat's to hand over: a card waiting, paused or returned, or a handoff not yet answered. */
  | { kind: 'waiting' }
  /** Its card was deleted before handover. */
  | { kind: 'withdrawn' }
  | { kind: 'accepted' }
  /** Sent at once and proven never delivered. `cancelled`: someone stopped it on purpose.
   *  `recovered`: a different turn was handed over and accepted, or the context cleared, after it settled. */
  | { kind: 'rejected'; cancelled: boolean; recovered: boolean }
  /** It may have reached the agent: admitted, with nothing left to say whether it did. */
  | { kind: 'unknown' }
  /** Refused before admission; its id would replay that refusal. */
  | { kind: 'refused' }
  /** A complete read, receipts included, proves it was never admitted. */
  | { kind: 'absent' }
  | { kind: 'unreadable' }

function submissionAnswer(
  journal: Pick<AgentSessionJournal, 'item' | 'inputOrder'> & {
    queuedMessages: Pick<AgentSessionJournal['queuedMessages'], 'inputState'>
  },
  submission: AgentJournalSubmission
): StructuredSendAnswer {
  switch (submission.dispatchState) {
    case 'accepted':
      return { kind: 'accepted' }
    case 'pending':
      return { kind: 'waiting' }
    case 'rejected': {
      if (submission.queuedMessageId !== undefined) {
        // A card's failed handoff: the card is the queue's to retry, never a mailbox copy.
        return { kind: 'waiting' }
      }
      // A proven rejection is placed at its settlement row; journal order, never clocks.
      const at = journal.item(agentJournalSubmissionKey(submission.clientMessageId))?.sequence
      const cleared = journal.queuedMessages.inputState().queuePauseMarks.cleared?.sequence ?? 0
      return {
        kind: 'rejected',
        cancelled: dispatchWasWithdrawn(submission),
        recovered:
          at !== undefined && (journal.inputOrder.links.acceptedHandover() > at || cleared > at)
      }
    }
    case 'unknown':
      return { kind: 'unknown' }
  }
}

/** One keyed read per send: the card first, then the send itself, then a gone card's handoff, and only
 *  then the admission receipt, which alone can prove nothing was admitted. */
export async function structuredSendAnswer(
  journal: SendAnswerJournal &
    Pick<AgentSessionJournal, 'item'> & {
      queuedMessages: Pick<AgentSessionJournal['queuedMessages'], 'inputState'>
    },
  readReceipt: (operationId: string) => CommandReceiptRead | Promise<CommandReceiptRead>,
  sessionId: string,
  operationId: string
): Promise<StructuredSendAnswer> {
  const card = journal.queuedMessages.get(operationId)
  if (card) {
    if (card.state === 'withdrawn') {
      return { kind: 'withdrawn' }
    }
    if (card.state !== 'dispatched' || card.consumedAs === null) {
      return { kind: 'waiting' }
    }
    const handoff = journal.submission(card.consumedAs)
    // Handed over, and its handoff's detail is gone: it may have reached the agent.
    return handoff ? submissionAnswer(journal, handoff) : { kind: 'unknown' }
  }
  const sent = journal.submission(operationId) ?? latestHandoff(journal, operationId)
  if (sent) {
    if (sent.clientMessageId !== operationId && sent.dispatchState === 'rejected') {
      return { kind: 'withdrawn' }
    }
    return submissionAnswer(journal, sent)
  }
  const receipt = await readReceipt(operationId)
  switch (receipt.verdict) {
    case 'absent':
      return { kind: 'absent' }
    case 'unreadable':
      return { kind: 'unreadable' }
    case 'readable':
      // An admission whose journal detail is gone stays in doubt, however old its id.
      return receipt.receipt.status === 'rejected' && receipt.receipt.sessionId === sessionId
        ? { kind: 'refused' }
        : { kind: 'unknown' }
  }
}
