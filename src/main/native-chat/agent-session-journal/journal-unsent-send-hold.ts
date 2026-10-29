// Keep provably unhanded personal text as queued cards on restart/close; reject the submission
// atomically to prevent duplicate handover. Other senders regenerate work or require explicit retry.

import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { USER_MESSAGE_SOURCE } from '../../../shared/agent-session/agent-session-message-source'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type { AgentSessionJournal } from './journal-store'
import type { JournalQueueCardChange } from './journal-queue-events'
import type { JournalQueuePlan } from './journal-queued-messages'

type QueuedMessagePositionMove = { messageId: string; position: number }

export type UnsentSendHold =
  /** Accepted by an earlier process. */
  | { cause: 'hostRestarted' }
  /** Restrict settlement when only part of a close completed. */
  | { cause: 'chatClosed'; which?: (submission: AgentJournalSubmission) => boolean }

/** Keep personal text only; existing card handoffs, commands, images and nonpersonal sends retain recovery. */
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
  // Unknown source kinds must never default to personal sends.
  const persons =
    source?.kind === USER_MESSAGE_SOURCE.kind ||
    // Before source existed, client origin identified personal sends.
    (source === undefined && submission.origin === 'client')
  return persons ? body : null
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

/** Atomically reject each send and keep its card; earlier kept cards lead, then this batch in admission order.
 * Try every row before throwing on write failure; return the latest settled admission cursor. */
export async function holdUnsentSends(
  journal: AgentSessionJournal,
  input: {
    fence: number
    hold: UnsentSendHold
    /** Settle handed-over sends instead when failed initialization proves none ran. */
    unrun?: true | ((submission: AgentJournalSubmission) => boolean)
  }
): Promise<number | null> {
  const { hold } = input
  const unsent = journal
    .submissions()
    .filter((entry) =>
      input.unrun
        ? isUnansweredHandedOverSubmission(entry) && (input.unrun === true || input.unrun(entry))
        : isQueuedAgentJournalSubmission(entry) &&
          (hold.cause === 'hostRestarted'
            ? journal.wroteBeforeOpen(entry.acceptedSequence)
            : (hold.which?.(entry) ?? true))
    )
    .sort((a, b) => (a.acceptedSequence ?? 0) - (b.acceptedSequence ?? 0))
  if (unsent.length === 0) {
    return null
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
      ...(index === 0 ? positions.earlier : []),
      ...positions.placed.filter((entry) => entry.messageId === submission.queuedMessageId)
    ]
    const position = positions.placed.find((entry) => entry.messageId === clientMessageId)?.position
    const card = body && position !== undefined ? { body, position } : null
    const keep: (() => JournalQueuePlan) | undefined =
      card || moves.length > 0
        ? () => {
            const { queuedMessages } = journal
            const changes: JournalQueueCardChange[] = moves.flatMap((move) =>
              queuedMessages.get(move.messageId)?.position === move.position
                ? []
                : [
                    {
                      messageId: move.messageId,
                      change: { op: 'moved' as const, position: move.position }
                    }
                  ]
            )
            if (card && !queuedMessages.get(clientMessageId)) {
              const queuedAt = { epoch, sequence: submission.acceptedSequence ?? 0 }
              const change = {
                op: 'queued' as const,
                body: card.body,
                position: card.position,
                queuedAt,
                ...(submission.options ? { options: submission.options } : {})
              }
              changes.push({ messageId: clientMessageId, change })
            }
            return queuedMessages.plan(changes)
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
      // Persist the kept-card link with rejection so clients do not render both.
      await journal.resolveDispatch(
        card ? { ...reject, keptAsQueuedMessageId: clientMessageId } : reject,
        keep
      )
    } catch (error) {
      if (!keep) {
        failures.push(error)
        continue
      }
      // Failed card recovery falls back to rejection; never leave the send stranded for impossible handover.
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
  return unsent.at(-1)?.acceptedSequence ?? 0
}

/** Order earlier kept cards first, then admissions; queuedAt cannot compare across epochs or handoff origins. */
function headOfQueuePositions(
  journal: AgentSessionJournal,
  batch: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[]
): { placed: QueuedMessagePositionMove[]; earlier: QueuedMessagePositionMove[] } {
  const cards = journal.queuedMessages.list()
  const keptIds = new Set(
    journal.submissions().flatMap((entry) => entry.keptAsQueuedMessageId ?? [])
  )
  const { epoch } = journal.cursor()
  // Earlier settlements survive either through explicit links or cards from earlier epochs.
  const earlier = cards
    .filter(
      (card) =>
        card.state === 'waiting' &&
        (keptIds.has(card.messageId) || (card.queuedAt !== null && card.queuedAt.epoch !== epoch))
    )
    .map((card) => card.messageId)
  const placed: QueuedMessagePositionMove[] = []
  for (const { submission, body } of batch) {
    const { clientMessageId } = submission
    if (body && !earlier.includes(clientMessageId)) {
      placed.push({ messageId: clientMessageId, position: 0 })
    } else if (
      // Explicit Send handoffs return to the head; automatic queue handoffs stay put.
      submission.origin === 'client' &&
      submission.queuedMessageId !== undefined &&
      cards.some((card) => card.consumedAs === clientMessageId)
    ) {
      placed.push({ messageId: submission.queuedMessageId, position: 0 })
    }
  }
  const inHead = (card: (typeof cards)[number]): boolean =>
    earlier.includes(card.messageId) || placed.some((move) => move.messageId === card.messageId)
  const others = cards.filter((card) => !inHead(card)).map((card) => card.position)
  const anchor = others.length > 0 ? Math.min(...others) : 1
  const first = anchor - earlier.length - placed.length
  return {
    earlier: earlier.map((messageId, index) => ({ messageId, position: first + index })),
    placed: placed.map((move, index) => ({ ...move, position: first + earlier.length + index }))
  }
}
