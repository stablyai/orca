import type Database from '../../../sqlite/sync-database'
import { readCommandReceipt } from '../writing/command-receipt-table'
import { journalSubmissionIsPersonal } from '../submissions/journal-submission-fold'
import {
  orchestrationMailNotice,
  USER_MESSAGE_SOURCE
} from '../../../../shared/agent-session/agent-session-message-source'
import { legacyQueuePositions } from './legacy-queue-positions'
import { journalInputOrder } from '../input-order/journal-input-order'
import type {
  AgentJournalItemBody,
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionJournal } from '../journal-store'
import type { JournalQueueCardChange } from './journal-queue-events'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { ResolveDispatchInput } from '../journal-store-contracts'
import type { JournalQueuePlan } from './journal-queued-messages'
// Keep provably unhanded input under its own row; host-derived work is re-derived by its owner.

export type UnsentSendHold =
  /** Accepted by an earlier process. */
  | { cause: 'hostRestarted' }
  /** Restrict settlement when only part of a close completed. */
  | { cause: 'chatClosed'; which?: (submission: AgentJournalSubmission) => boolean }

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

/** A refused initialization returns only direct personal text; custody and commands own their failures. */
function failedStartSendKeptAsCard(
  submission: Pick<AgentJournalSubmission, 'queuedMessageId' | 'source' | 'origin'>,
  body: AgentJournalItemBody | null
): AgentJournalMessageItem | null {
  if (submission.queuedMessageId !== undefined || body?.kind !== 'message' || body.command) {
    return null
  }
  return submission.source?.kind === USER_MESSAGE_SOURCE.kind ||
    (submission.source === undefined && submission.origin === 'client')
    ? body
    : null
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
  const unsent = journal.inputOrder
    .recoverableSubmissions()
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
  const { epoch } = journal.physicalCursor()
  const kept = unsent.map((submission) => ({
    submission,
    body: unsentSendKeptAsCard(
      submission,
      journal.itemBody(agentJournalSubmissionKey(submission.clientMessageId))
    )
  }))
  const positions = journal.inputOrder.legacy
    ? legacyQueuePositions(journal, kept, Boolean(input.unrun))
    : currentQueuePositions(journal, kept)
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
                ...(journal.inputOrder.queueFormat() === 3
                  ? {
                      deliveryMode: 'queue' as const,
                      unattended: !journal.inputOrder.personalSubmission(submission)
                    }
                  : {}),
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
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'settling unsent sends failed')
  }
  return unsent.at(-1)?.acceptedSequence ?? 0
}

/** Failed starts return the person's direct input in the rejection's own transaction. */
export function keepFailedStartSends(
  state: JournalReducerState,
  dispatches: readonly ResolveDispatchInput[]
): { cards: JournalQueueCardChange[]; dispatches: typeof dispatches } {
  const cards: JournalQueueCardChange[] = []
  let position = journalInputOrder(state).cardBounds(state).first - dispatches.length
  return {
    cards,
    dispatches: dispatches.map((dispatch) => {
      const send = state.submissions.get(dispatch.clientMessageId)
      const body =
        send &&
        failedStartSendKeptAsCard(
          send,
          state.items.get(agentJournalSubmissionKey(send.clientMessageId))?.body ?? null
        )
      if (
        !body ||
        dispatch.state !== 'rejected' ||
        state.queue.cards.has(dispatch.clientMessageId)
      ) {
        return dispatch
      }
      cards.push({
        messageId: dispatch.clientMessageId,
        change: {
          op: 'queued',
          body,
          position: position++,
          queuedAt: { epoch: state.epoch, sequence: send?.acceptedSequence ?? 0 },
          ...(journalInputOrder(state).queueFormat() === 3 && send
            ? {
                deliveryMode: 'queue' as const,
                unattended: !journalSubmissionIsPersonal(state, send)
              }
            : {}),
          ...(send?.options ? { options: send.options } : {}),
          returned: { reason: dispatch.reason, rejection: dispatch.rejection }
        }
      })
      return { ...dispatch, keptAsQueuedMessageId: dispatch.clientMessageId }
    })
  }
}

/** A new writer owns one current input; linked hand-offs retain their row's reserved slot. */
function currentQueuePositions(
  journal: AgentSessionJournal,
  batch: readonly { submission: AgentJournalSubmission; body: AgentJournalMessageItem | null }[]
): { placed: Map<string, number>; moves: { messageId: string; position: number }[] } {
  const cards = journal.queuedMessages.list()
  let position = cards.reduce((first, card) => Math.min(first, card.position), 0) - batch.length
  return {
    placed: new Map(
      batch
        .filter((entry) => entry.body)
        .map(({ submission }) => [submission.clientMessageId, position++])
    ),
    moves: []
  }
}

/** Finish old-order conversion before any new runtime admission can stamp format 3. */
export async function recoverJournalQueue(
  journal: AgentSessionJournal,
  db: Database.Database
): Promise<void> {
  await holdUnsentSends(journal, {
    fence: journal.queuedMessages.inputState().highestFence,
    hold: { cause: 'hostRestarted' }
  })
  const withdrawn = journal.queuedMessages.list().filter((row) => {
    if (row.body.from?.orchestration?.message === 'task' && row.deliveryMode === 'steer') {
      return true
    }
    const receipt = readCommandReceipt(db, { kind: 'global' }, row.messageId)
    return (
      receipt.verdict === 'readable' &&
      receipt.receipt.callerKey === 'trusted-local:restart-continuation'
    )
  })
  await journal.queuedMessages.withdraw(withdrawn.map((row) => row.messageId))
  journal.inputOrder.legacy = undefined
}
