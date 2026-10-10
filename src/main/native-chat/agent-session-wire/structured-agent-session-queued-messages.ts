// Mid-turn queueing: the accept decision that turns a send into a host-held
// draft, the serialized drain that converts one draft into an ordinary
// submission when the session stops owing work, and the published draft list.
//
// Drafts are never owed work: they feed no reducer, no working status, no
// teardown and no idle sweep. The drain re-reads every gate inside its own
// serialized step, so there is no loop state to disagree with the journal.

import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionSendResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  contextStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork
} from './structured-agent-session-current-work'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { isSqliteContentionFailure } from '../../sqlite/sqlite-read-failure'
import type { StructuredAgentSessionRetry } from './structured-agent-session-reconciliation-retry'
import { QueuedSendAbandonment } from './structured-agent-session-queued-abandonment'
import {
  structuredAgentSessionHostInstance,
  structuredQueuePauses
} from './structured-agent-session-queued-pause'
import { nextSendableQueuedCard } from '../agent-session-journal/queued-message-pause'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { agentSessionAttachmentExpiredRefusal } from './structured-agent-session-turns'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'

/** Text-only v1: any image block routes to the immediate path. */
export function queuedMessageBodyIsTextOnly(body: AgentJournalMessageItem): boolean {
  return body.blocks.every((block) => block.type === 'text')
}

/** Waiting, not held on its own, and not positioned behind a returned card or a
 *  card the queue's pause holds: the queue never reorders. The admission rule
 *  (§accept) and the drain's selection both read it. */
function oldestActionableQueuedMessage(
  journal: Pick<AgentSessionJournal, 'queuedMessages'>
): QueuedMessageRow | null {
  const rows = journal.queuedMessages.list()
  // Nothing waiting costs no pause derivation: this runs on every journal publish.
  if (!rows.some((row) => row.state === 'waiting')) {
    return null
  }
  return nextSendableQueuedCard(structuredQueuePauses(journal), rows)
}

/**
 * Why the queue is not sending right now — ONE decision for admission, the
 * drain step and Send-now, so the lists cannot drift. Each caller's override
 * policy sits next to its use:
 *
 *   admission: `blocked` refuses (the immediate path's own refusal); any other
 *     hold, or an actionable backlog, queues the send as a draft.
 *   drain step: any hold returns early; whatever clears it publishes or
 *     commits, which re-derives.
 *   Send-now: overrides only `working` (plus FIFO order and the stored hold),
 *     never for a command card; `blocked` and `prompt` refuse readably.
 *
 * `blocked` is whatever refuses any send (an uncertain rewind, a cleared source);
 * the rest are waits. A /compact is a queued message and then a turn,
 * so it holds the queue as `working`; an older build's compaction record belongs
 * to a child this host no longer runs and holds nothing. Host-local vocabulary —
 * never on the wire.
 */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

/** What the queue's gate reads: the record, and the host's projection of current work
 *  (`structuredAgentSessionCurrentWork`), so an ended generation's leftovers hold nothing. */
export type StructuredQueueGateInput = {
  record: AgentSessionRecord | null
  work: StructuredAgentSessionCurrentWork
  /** The drain's own waits past the gate (`StructuredAgentSessionQueuedMessageDrain.waits`): a
   *  card it holds back is not one a client is told it sends next. */
  drainWaits?: (messageId: string) => boolean
}

export function structuredQueueHold(input: StructuredQueueGateInput): StructuredQueueHold | null {
  // Whatever refuses any send refuses the queue too: an uncertain rewind or a source a
  // clear superseded. One rule, the immediate path's own.
  if (structuredAgentSessionSendBlock(input.record)) {
    return 'blocked'
  }
  // `prompt` outranks `working`: it is the one wait Send-now may not override,
  // so a prompt raised mid-turn must not read as merely `working`.
  if (input.work.hasActionablePrompt()) {
    return 'prompt'
  }
  return input.work.working() ? 'working' : null
}

/** The card the drain sends next, or null while anything holds the queue: the drain's own pick
 *  through the one gate, so a client told this reads what the drain acts on. Live facts only; the
 *  backlog is never a gate, so a lone draft drains. */
export function nextStructuredQueuedMessage(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal }
): QueuedMessageRow | null {
  const next = oldestActionableQueuedMessage(input.journal)
  // The gate's cheap `working` first: publication asks on every streamed frame, and the gate's
  // prompt check walks the whole fold.
  if (next === null || input.work.working()) {
    return null
  }
  return structuredQueueHold(input) === null && !input.drainWaits?.(next.messageId) ? next : null
}

/**
 * Whether a `queue-if-active` send becomes a draft: any queue hold short of
 * `blocked`, or an actionable draft already exists (FIFO backlog — an
 * ADMISSION rule only, never a drain gate). A lone returned card, or a paused
 * queue, does not trap a new send: the user acting now wins, and that send's
 * turn starting is what lifts the pause — Orca's own queue policy, a stated
 * deviation from held-head backlog counting.
 */
export function shouldQueueStructuredAgentSessionSend(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal }
): boolean {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // The immediate path's own refusal (`structuredAgentSessionSendBlock`)
    // answers; queueing behind a fence would strand the draft.
    return false
  }
  if (hold !== null) {
    return true
  }
  return oldestActionableQueuedMessage(input.journal) !== null
}

/**
 * The accept branch: a capable send while the session is working (or behind an
 * actionable backlog) becomes a draft instead of a submission. Returns null for
 * the immediate path — an incapable client, an image body (text-only v1), a
 * replayed id the journal already answers, or an idle session.
 */
export async function maybeQueueStructuredAgentSessionSend(
  context: {
    deps: { store: { getRecord: (sessionId: string) => AgentSessionRecord | null } }
  },
  ctx: Pick<
    AgentSessionTurnContext,
    'sessionId' | 'journal' | 'fence' | 'operationReceipt' | 'currentWork'
  >,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    /** A person's send at a chat surface: every attachment it names must still be stored. */
    userSend?: true
    /** A person's message the host sends for them. */
    personsMessage?: true
  }
): Promise<
  | { ok: true; value: AgentSessionSendResult }
  | { ok: false; refusal: AgentSessionWireRefusal }
  | null
> {
  const clientMessageId = params.envelope.clientOperationId
  if (params.delivery !== 'queue-if-active' || !queuedMessageBodyIsTextOnly(params.body)) {
    return null
  }
  // Asked again with no ledger answer: a send this host queued answers as its replay would —
  // its hand-off goes out under a fresh id, so no submission under this id guards it.
  const queuedBefore = queuedSendAnswer(ctx.journal, clientMessageId)
  if (queuedBefore) {
    return { ok: true, value: queuedBefore }
  }
  // A recorded direct submission under this id replays through today's path.
  if (ctx.journal.submissions().some((entry) => entry.clientMessageId === clientMessageId)) {
    return null
  }
  if (
    !shouldQueueStructuredAgentSessionSend({
      journal: ctx.journal,
      record: context.deps.store.getRecord(ctx.sessionId),
      work: contextStructuredAgentSessionCurrentWork(ctx)
    })
  ) {
    return null
  }
  const refusal = queuedMessagesPublishedBytesRefusal(
    ctx.journal,
    params.body,
    params.userSend === true || params.personsMessage === true
  )
  if (refusal) {
    return { ok: false, refusal }
  }
  // The insert notifies through the journal's commit listener: publication and
  // the drain re-derive with no call here to forget.
  let row: QueuedMessageRow
  try {
    row = await ctx.journal.queuedMessages.insert(
      {
        messageId: clientMessageId,
        body: params.body,
        // In the session that will send it: the reducer aliases the provider's echo by exactly this.
        fingerprint: agentSessionSendBodyFingerprint(ctx.sessionId, params.body),
        hostInstance: structuredAgentSessionHostInstance(),
        ...(params.userSend ? { requireAttachments: true } : {})
      },
      ctx.operationReceipt
    )
  } catch (error) {
    if (isAgentSessionAttachmentExpiredError(error)) {
      return agentSessionAttachmentExpiredRefusal()
    }
    throw error
  }
  return {
    ok: true,
    value: {
      clientMessageId,
      queued: { messageId: row.messageId, position: row.position, state: row.state }
    }
  }
}

export type QueuedMessageDrainDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  conversationFence: (sessionId: string) => number
  /** The host's projection of the chat's current work (`structuredAgentSessionCurrentWork`). */
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
  /** The consumed submission is ordinary #22821 work from here on. */
  wakeDelivery: (sessionId: string) => void
  /** The host's retry (`StructuredAgentSessionRetry`), read lazily: it is built after the drain. */
  retry: () => Pick<StructuredAgentSessionRetry, 'sendContended' | 'sendWaits'>
  /** Re-sends what clients read (`AgentSessionSubscribers.publish`): an abandon writes nothing. */
  publish: (sessionId: string, journal: AgentSessionJournal) => void
  logger: StructuredAgentSessionLogger
}

/**
 * The serialized drain. Woken by every journal commit (turn, submission, prompt,
 * command and Stop settlements are all commits), by draft mutations, by the
 * conversation opening, and by a generation ending, which may write nothing
 * (`StructuredAgentSessionClientDelivery.publishGenerationEnded`); each step
 * re-derives everything and consumes at most one draft — the consumed submission
 * then owes work, which gates the next.
 */
export class StructuredAgentSessionQueuedMessageDrain {
  private readonly scheduled = new Set<string>()
  private disposed = false
  private readonly abandoned = new QueuedSendAbandonment()

  constructor(private readonly deps: QueuedMessageDrainDeps) {}

  /** Quit, with delivery: a hand-off made now could only be settled by the next process, so a
   *  quit leaves the cards exactly as a crash does. Read by the step at its start, and again
   *  right before it appends, since quit can land while it awaits. */
  dispose(): void {
    this.disposed = true
  }

  /** Whether this card's automatic send waits for the retry's next round, or was given up on. A
   *  person's Send now waits on neither. */
  waits = (sessionId: string, messageId: string): boolean =>
    this.deps.retry().sendWaits(sessionId) || this.abandoned.card(sessionId) === messageId

  /** The card a given-up send left, which the queue shows as not sent. */
  abandonedCard = (sessionId: string): string | undefined => this.abandoned.card(sessionId)

  /** A person moved the card on (Send now, Delete). */
  cardMoved(sessionId: string): void {
    this.abandoned.clear(sessionId)
  }

  /** The retry gave up on the chat's automatic send: its card reads as not sent at once, and the
   *  stored hold is tried once; should that fail too, this mark still shows it. */
  abandon(sessionId: string): void {
    const journal = this.deps.sessions.get(sessionId)?.journal
    const next = journal ? oldestActionableQueuedMessage(journal) : null
    if (!journal || !next) {
      return
    }
    this.abandoned.mark(sessionId, next.messageId, journal.queuedMessages)
    this.deps.publish(sessionId, journal)
  }

  schedule(sessionId: string): void {
    const journal = this.disposed ? undefined : this.deps.sessions.get(sessionId)?.journal
    if (!journal) {
      return
    }
    // Cheap pre-check so token streams do not pay a serialized step per delta.
    // Skipping while working is safe: whatever ends the work is a commit or a generation's end,
    // and each schedules again; the step re-reads every gate.
    try {
      if (
        !journal.queuedMessages.settlementOwed() &&
        (oldestActionableQueuedMessage(journal) === null ||
          this.deps.currentWork(sessionId)?.working() !== false)
      ) {
        return
      }
    } catch {
      // The handle is opening or closing; the next commit re-schedules.
      return
    }
    if (this.scheduled.has(sessionId)) {
      return
    }
    this.scheduled.add(sessionId)
    void this.deps
      .serialize(sessionId, () => {
        this.scheduled.delete(sessionId)
        return this.step(sessionId, false)
      })
      .catch((error: unknown) => {
        this.scheduled.delete(sessionId)
        this.warn(sessionId, error)
      })
  }

  /** The retry's own send of the chat's next card (`StructuredAgentSessionRetry`): whether another
   *  connection's lock refused it, which ends the retry's round. */
  sendForRetry(sessionId: string): Promise<'contended' | 'done'> {
    return this.deps
      .serialize(sessionId, () => this.step(sessionId, true))
      .catch((error: unknown) => {
        this.warn(sessionId, error)
        return 'done' as const
      })
  }

  private warn(sessionId: string, error: unknown): void {
    this.deps.logger.warn('draining queued messages failed', {
      scope: 'queued-drain',
      sessionId,
      error
    })
  }

  /** `forRetry`: the retry's own attempt, which a send it owes does not hold back. */
  private async step(sessionId: string, forRetry: boolean): Promise<'contended' | 'done'> {
    const session = this.deps.sessions.get(sessionId)
    if (this.disposed || !session) {
      return 'done'
    }
    const journal = session.journal
    if (journal.queuedMessages.settlementOwed() || journal.queuedMessages.deliveredByEchoOwed()) {
      // A live per-row hook was skipped; heal now, before a draft sends, rather than at reopen.
      await journal.queuedMessages.settleOwed().catch((error: unknown) => {
        this.deps.logger.warn('settling owed queued-message bookkeeping failed', {
          scope: 'queued-settle-owed',
          sessionId,
          error
        })
      })
    }
    const fence = this.deps.conversationFence(sessionId)
    // Whatever clears a hold publishes or commits, which re-derives this step.
    const record = this.deps.getRecord(sessionId)
    const work = this.deps.currentWork(sessionId)
    const next = work ? nextStructuredQueuedMessage({ journal, record, work }) : null
    if (this.disposed || !next || (!forRetry && this.deps.retry().sendWaits(sessionId))) {
      return 'done'
    }
    // Always a fresh id: the submission names its draft by `queuedMessageId`, never by id equality.
    const submissionId = createStructuredAgentSessionOperationId(randomUUID)
    try {
      await journal.appendSubmission(
        {
          clientMessageId: submissionId,
          // The queue's own automatic send, never kept as a card by a restart or a close.
          origin: 'host',
          payloadFingerprint: next.fingerprint,
          body: next.body,
          fence,
          handoverRecorded: true
        },
        {
          messageId: next.messageId,
          expect: 'waiting',
          settledByOp: null,
          hostInstance: structuredAgentSessionHostInstance(),
          yieldsToPause: true,
          background: true
        }
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
        // Lost a race with a Send-now, a Delete or a Stop; their transition stands.
        return 'done'
      }
      // Another connection holds the database: the retry sends it in its next round, nothing shown.
      if (isSqliteContentionFailure(error)) {
        if (!forRetry) {
          this.deps.retry().sendContended(sessionId)
        }
        return 'contended'
      }
      // A refusal: the draft stays waiting, held with the marker on the card (a stored fact, so it
      // survives eviction and restart). The hold's own commit notification publishes it. An
      // explicit Send retries.
      await journal.queuedMessages
        .hold({ messageIds: [next.messageId], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
        .catch(() => {})
      throw error
    }
    this.abandoned.clear(sessionId)
    this.deps.wakeDelivery(sessionId)
    return 'done'
  }
}
