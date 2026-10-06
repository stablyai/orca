// What becomes of a send the host accepted and can no longer hand over: an earlier host process
// quit or crashed first (settled at the next open), or the chat is closing. Either way the agent
// provably never got it. A person's message (typed, or a launch's first prompt) is kept as a card
// at the head of the queue, held until the person sends, edits or deletes it (`kept`). Everything
// else is rejected as before, because something else re-derives it or the person re-runs it. The
// submission itself is always rejected, so it is never handed over twice.

import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { QUEUED_MESSAGE_PAUSED_KEPT } from '../../../shared/agent-session-queued-message-wire'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session-message-source'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentSessionJournal } from './journal-store'
import type { JournalRowTransactionHook } from './journal-row-writer'
import type { QueuedMessagePositionMove } from './queued-message-positions'

/** Why the host can no longer hand a send over, which also says which sends it is. */
export type UnsentSendHold =
  /** At open, and the delivery loop's first step: what an earlier host process accepted. */
  | { cause: 'hostRestarted' }
  /** A close of the chat; `which` narrows it to what a close that did not complete closed. */
  | { cause: 'chatClosed'; which?: (submission: AgentJournalSubmission) => boolean }

/** The body an unsent send is kept with, or null when it is rejected instead:
 *  - a card's own hand-off: its rejection already returns the card (`rejectedDraftSettlement`);
 *  - `/compact` and other commands: a command in flight is not resumed, the person re-runs it;
 *  - an image: cards are text-only;
 *  - a send not from a person: orchestration mail (the mailbox re-sends it), a dispatch preamble
 *    or a restart continuation (their owners re-derive them), a kind this build does not know, and
 *    a row with no source that is not a person's (it could be either). */
export function unsentSendKeptAsCard(
  submission: Pick<AgentJournalSubmission, 'queuedMessageId' | 'source' | 'origin'>,
  body: AgentJournalItemBody | null
): AgentJournalMessageItem | null {
  if (submission.queuedMessageId !== undefined || body?.kind !== 'message' || body.command) {
    return null
  }
  if (!body.blocks.every((block) => block.type === 'text')) {
    return null
  }
  const { source } = submission
  // Exactly 'user': never a fallback that reads a kind it does not know as the person's.
  const persons =
    source?.kind === USER_MESSAGE_SOURCE.kind ||
    // A build before `source` was recorded: `client` was only ever a person's send.
    (source === undefined && submission.origin === 'client')
  return persons ? body : null
}

/**
 * Settles every send `hold` names. Each is rejected with the hold's cause in its own row, and a
 * kept one becomes a card in that row's transaction, so a crash between them can never leave
 * both. This batch's cards, and the card of a Send the person asked for, go to the head of the
 * queue in the order they were accepted, behind the cards an earlier settlement kept; the queue's
 * own hand-off returns its card where it stood. Throws once every row was
 * tried when one of them could not be written at all: that row stays queued.
 */
export async function holdUnsentSends(
  journal: AgentSessionJournal,
  input: { fence: number; hostInstance: string; hold: UnsentSendHold }
): Promise<void> {
  const { hold } = input
  const unsent = journal
    .submissions()
    .filter(
      (entry) =>
        isQueuedAgentJournalSubmission(entry) &&
        (hold.cause === 'hostRestarted'
          ? journal.wroteBeforeOpen(entry.acceptedSequence)
          : (hold.which?.(entry) ?? true))
    )
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  if (unsent.length === 0) {
    return
  }
  const { epoch } = journal.cursor()
  const kept = unsent.map((submission) => ({
    submission,
    body: unsentSendKeptAsCard(
      submission,
      journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
    )
  }))
  const positions = headOfQueuePositions(journal, kept)
  const rejection = agentSessionFailureWords(agentSessionFailureFact(hold.cause), {
    surface: 'rejection'
  })
  const failures: unknown[] = []
  for (const [index, { submission, body }] of kept.entries()) {
    const { clientMessageId } = submission
    const moves = [
      // The cards an earlier settlement kept move with the first row.
      ...(index === 0 ? positions.earlier : []),
      ...(submission.queuedMessageId !== undefined
        ? positions.placed.filter(
            (entry) => 'consumedAs' in entry && entry.consumedAs === clientMessageId
          )
        : [])
    ]
    const position = positions.placed.find(
      (entry) => 'messageId' in entry && entry.messageId === clientMessageId
    )?.position
    const card = body && position !== undefined ? { body, position } : null
    const keep: JournalRowTransactionHook | undefined =
      card || moves.length > 0
        ? (db) => {
            journal.queuedMessages.holdInTransaction(db, {
              card: card
                ? {
                    messageId: clientMessageId,
                    body: card.body,
                    fingerprint: agentSessionSendBodyFingerprint(
                      journal.queuedMessages.sessionId,
                      card.body
                    ),
                    hostInstance: input.hostInstance,
                    holdReason: QUEUED_MESSAGE_PAUSED_KEPT,
                    queuedAt: { epoch, sequence: submission.acceptedSequence ?? 0 },
                    position: card.position
                  }
                : null,
              positions: moves
            })
          }
        : undefined
    const reject = {
      clientMessageId,
      state: 'rejected' as const,
      ...rejection,
      fence: input.fence,
      recovered: true as const
    }
    try {
      // The send names its card in the same row, so no surface draws it once the card is gone.
      await journal.resolveDispatch(
        card ? { ...reject, keptAsQueuedMessageId: clientMessageId } : reject,
        keep
      )
    } catch (error) {
      if (!keep) {
        failures.push(error)
        continue
      }
      // Keeping it failed: rejected as before. That loses the message, as every build before this
      // one did; it is never left queued for a handover nothing will make.
      console.warn('[journal-hold] keeping an unsent send failed:', {
        sessionId: journal.queuedMessages.sessionId,
        clientMessageId,
        cause: hold.cause,
        error: error instanceof Error ? error.message : String(error)
      })
      await journal.resolveDispatch(reject).catch((fallback: unknown) => failures.push(fallback))
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'settling unsent sends failed')
  }
}

/** Where each card of the batch goes: right before every other card, the cards an earlier
 *  settlement kept first, in the order they stand, then this batch's cards and the cards of the
 *  person's own Sends in the order they were accepted. A kept card's `queuedAt` cannot order it against
 *  them: sequences restart with each epoch, and a returned hand-off's names its draft's time. */
function headOfQueuePositions(
  journal: AgentSessionJournal,
  batch: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[]
): { placed: QueuedMessagePositionMove[]; earlier: QueuedMessagePositionMove[] } {
  const cards = journal.queuedMessages.list()
  const earlier = cards
    .filter((card) => card.state === 'waiting' && card.holdReason === QUEUED_MESSAGE_PAUSED_KEPT)
    .map((card) => card.messageId)
  const placed: QueuedMessagePositionMove[] = []
  for (const { submission, body } of batch) {
    const { clientMessageId } = submission
    if (body && !earlier.includes(clientMessageId)) {
      placed.push({ messageId: clientMessageId, position: 0 })
    } else if (
      // Kept by its settlement (`rejectedDraftSettlement`): a Send the person asked for.
      submission.origin === 'client' &&
      cards.some((card) => card.consumedAs === clientMessageId)
    ) {
      placed.push({ consumedAs: clientMessageId, position: 0 })
    }
  }
  const inHead = (card: (typeof cards)[number]): boolean =>
    earlier.includes(card.messageId) ||
    placed.some((move) =>
      'messageId' in move ? move.messageId === card.messageId : move.consumedAs === card.consumedAs
    )
  const others = cards.filter((card) => !inHead(card)).map((card) => card.position)
  const anchor = others.length > 0 ? Math.min(...others) : 1
  const first = anchor - earlier.length - placed.length
  return {
    earlier: earlier.map((messageId, index) => ({ messageId, position: first + index })),
    placed: placed.map((move, index) => ({ ...move, position: first + earlier.length + index }))
  }
}
