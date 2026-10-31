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
            ? journal.inputOrder.recoveryPending(entry.clientMessageId)
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
  const positions = headOfQueuePositions(journal, kept, Boolean(input.unrun))
  const rejection = agentSessionFailureWords(agentSessionFailureFact(hold.cause), {
    surface: 'rejection'
  })
  const failures: unknown[] = []
  let ranksCommitted = false
  for (const { submission, body } of kept) {
    const { clientMessageId } = submission
    const moves = ranksCommitted ? [] : positions.moves
    const position = positions.placed.get(clientMessageId)
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
              const queuedAt = { epoch, sequence: submission.submittedSequence! }
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
      if (keep) {
        ranksCommitted = true
      }
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

/** Merge logical places once, then materialize finite ranks with the first successful keep. */
function headOfQueuePositions(
  journal: AgentSessionJournal,
  batch: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[],
  unrun: boolean
): { placed: Map<string, number>; moves: QueuedMessagePositionMove[] } {
  const cards = journal.queuedMessages.list()
  const keptIds = new Set(
    journal.submissions().flatMap((entry) => entry.keptAsQueuedMessageId ?? [])
  )
  const { epoch } = journal.cursor()
  const state = journal.queuedMessages.displayState()
  const forcedBatch = batch.some(({ submission }) =>
    journal.inputOrder.forced(submission.clientMessageId)
  )
  const earlier: string[] = []
  const rest: (typeof cards)[number][] = []
  const cardsById = new Map(cards.map((card) => [card.messageId, card]))
  const explicitHeads = new Map(
    batch.flatMap(({ submission }) => {
      const id = submission.origin === 'client' ? submission.queuedMessageId : undefined
      return id && cardsById.get(id)?.consumedAs === submission.clientMessageId
        ? [[submission.clientMessageId, id] as const]
        : []
    })
  )
  const explicit = new Set(explicitHeads.values())
  for (const card of cards) {
    if (explicit.has(card.messageId)) {
      continue
    }
    if (
      card.state === 'waiting' &&
      ((unrun && keptIds.has(card.messageId)) ||
        (!forcedBatch && card.queuedAt && card.queuedAt.epoch !== epoch))
    ) {
      earlier.push(card.messageId)
    } else {
      rest.push(card)
    }
  }
  const at = new Map<number, string[]>()
  const head: string[] = []
  const firstCut = batch
    .flatMap(
      ({ submission }) => journal.inputOrder.place(submission.clientMessageId)?.context.cut ?? []
    )
    .reduce((a, b) => Math.min(a, b), Infinity)
  let previousBoundary = 0
  for (let i = 0; i < rest.length; i++) {
    if (
      rest[i].state === 'waiting' &&
      keptIds.has(rest[i].messageId) &&
      (journal.inputOrder.lineage.cards.get(rest[i].messageId)?.introduced ?? -Infinity) < firstCut
    ) {
      previousBoundary = i + 1
    }
  }
  for (const { submission, body } of batch) {
    const id = body ? submission.clientMessageId : explicitHeads.get(submission.clientMessageId)
    if (!id || keptIds.has(id)) {
      continue
    }
    if (!body && previousBoundary > 0) {
      head.push(id)
      continue
    }
    const after = journal.inputOrder.forced(submission.clientMessageId)
      ? journal.inputOrder.predecessors(state, submission.clientMessageId).position
      : -Infinity
    let low = 0,
      high = rest.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (rest[mid].position <= after) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    const boundary = Math.max(previousBoundary, low)
    previousBoundary = boundary
    const bucket = at.get(boundary) ?? []
    bucket.push(id)
    at.set(boundary, bucket)
  }
  const order = [...earlier, ...head]
  for (let i = 0; i <= rest.length; i++) {
    order.push(...(at.get(i) ?? []))
    if (i < rest.length) {
      order.push(rest[i].messageId)
    }
  }
  const placed = new Map(order.map((id, index) => [id, index]))
  return {
    placed,
    moves: cards.flatMap((card) => {
      const position = placed.get(card.messageId)!
      return position === card.position ? [] : [{ messageId: card.messageId, position }]
    })
  }
}
