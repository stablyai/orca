import type { AgentSessionSendResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { CommandReceiptRead } from '../../agent-session-journal/writing/command-receipt-table'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { dispatchWasWithdrawn } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { SqlJournalQueuedMessages } from '../../agent-session-journal/journal-sql-queued-messages'

type SendAnswerJournal = {
  reads: Pick<AgentSessionJournal['reads'], 'input' | 'submission'>
  queuedMessages: Pick<AgentSessionJournal['queuedMessages'] | SqlJournalQueuedMessages, 'get'>
}

/** A card whose row is gone answers from its latest handoff, found by key, never by a history scan. */
async function latestHandoff(
  journal: Pick<SendAnswerJournal, 'reads'>,
  messageId: string
): Promise<AgentJournalSubmission | undefined> {
  let latest: AgentJournalSubmission | undefined
  for (const handoff of (await journal.reads.input({ kind: 'linked-to', messageId })).submissions) {
    if (
      handoff.queuedMessageId === messageId &&
      (handoff.submittedSequence ?? 0) >= (latest?.submittedSequence ?? 0)
    ) {
      latest = handoff
    }
  }
  return latest
}

/** Refused conversions replay as returned cards, avoiding duplicate Retry rows; null means never queued. */
export async function queuedSendAnswer(
  journal: SendAnswerJournal,
  clientMessageId: string
): Promise<AgentSessionSendResult | null> {
  const draft = await journal.queuedMessages.get(clientMessageId)
  if (draft) {
    const consumed =
      draft.state === 'dispatched' && draft.consumedAs !== null
        ? await journal.reads.submission(draft.consumedAs)
        : undefined
    return consumed
      ? { clientMessageId, submission: { ...consumed } }
      : {
          clientMessageId,
          queued: { messageId: draft.messageId, position: draft.position, state: draft.state }
        }
  }
  // Missing cards with rejected handoffs were deleted; replay withdrawn rather than a refused send.
  const handoff = await latestHandoff(journal, clientMessageId)
  if (handoff?.dispatchState === 'rejected') {
    return {
      clientMessageId,
      queued: { messageId: clientMessageId, position: 0, state: 'withdrawn' }
    }
  }
  return handoff ? { clientMessageId, submission: { ...handoff } } : null
}

/** What became of one send, answered by the host that admitted it. */
export type { StructuredSendAnswer } from '../../agent-session-journal/journal-mail-observation'
import type { StructuredSendAnswer } from '../../agent-session-journal/journal-mail-observation'

async function submissionAnswer(
  journal: {
    reads: Pick<AgentSessionJournal['reads'], 'item' | 'submission' | 'input'>
    queuedMessages: Pick<
      AgentSessionJournal['queuedMessages'] | SqlJournalQueuedMessages,
      'clearedThrough'
    >
  },
  submission: AgentJournalSubmission
): Promise<StructuredSendAnswer> {
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
      const at = (await journal.reads.item(agentJournalSubmissionKey(submission.clientMessageId)))
        ?.sequence
      const cleared = await journal.queuedMessages.clearedThrough()
      const accepted = (await journal.reads.input({ kind: 'latest-accepted-handover' })).sequence
      return {
        kind: 'rejected',
        cancelled: dispatchWasWithdrawn(submission),
        recovered: at !== undefined && (accepted > at || cleared > at)
      }
    }
    case 'unknown':
      return { kind: 'unknown' }
  }
}

/** One keyed read per send: the card first, then the send itself, then a gone card's handoff, and only
 *  then the admission receipt, which alone can prove nothing was admitted. */
export async function structuredSendAnswer(
  journal: {
    reads: Pick<AgentSessionJournal['reads'], 'item' | 'submission' | 'input'>
    queuedMessages: Pick<
      AgentSessionJournal['queuedMessages'] | SqlJournalQueuedMessages,
      'get' | 'clearedThrough'
    >
  },
  readReceipt: (operationId: string) => CommandReceiptRead | Promise<CommandReceiptRead>,
  sessionId: string,
  operationId: string
): Promise<StructuredSendAnswer> {
  const card = await journal.queuedMessages.get(operationId)
  if (card) {
    if (card.state === 'withdrawn') {
      return { kind: 'withdrawn' }
    }
    if (card.state !== 'dispatched' || card.consumedAs === null) {
      return { kind: 'waiting' }
    }
    const handoff = await journal.reads.submission(card.consumedAs)
    // Handed over, and its handoff's detail is gone: it may have reached the agent.
    return handoff ? submissionAnswer(journal, handoff) : { kind: 'unknown' }
  }
  const sent =
    (await journal.reads.submission(operationId)) ?? (await latestHandoff(journal, operationId))
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
