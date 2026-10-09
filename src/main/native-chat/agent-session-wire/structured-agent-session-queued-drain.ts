// The serialized drain of mid-turn queueing: one step at a time per conversation, each converting
// at most one draft into an ordinary submission when the queue's gate lets it (or running a /clear
// card itself). It holds no loop state: every step re-reads the gate from the journal.

import { randomUUID } from 'node:crypto'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session-wire'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionBackgroundTaskStops } from '../../../shared/agent-child-work-stop-targets'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
import { QueuedMessageNotConsumableError } from '../agent-session-journal/journal-queued-messages'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import {
  nextStructuredQueuedMessage,
  structuredQueueHeadMayRun
} from './structured-agent-session-queued-messages'
import { isQueuedClearCard } from './structured-conversation-clear'

export type QueuedMessageDrainDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  getRecord: (sessionId: string) => AgentSessionRecord | null
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  conversationFence: (sessionId: string) => number
  /** The consumed submission is ordinary #22821 work from here on. */
  wakeDelivery: (sessionId: string) => void
  logger: StructuredAgentSessionLogger
  readChildWork: (sessionId: string) => readonly AgentChildWorkView[] | undefined
  backgroundTaskStops: (sessionId: string) => AgentSessionBackgroundTaskStops | undefined
  stoppedTaskEndingOwed: (sessionId: string) => boolean
  /** Runs a /clear card itself, inside the step's serialize (`runQueuedConversationClear`). */
  runClear: (sessionId: string, card: QueuedMessageRow) => Promise<unknown>
}

/**
 * The serialized drain. Woken by every journal commit (turn, submission, prompt,
 * command and Stop settlements are all commits), by draft mutations, and by the
 * conversation opening; each step re-derives everything and consumes at most one
 * draft — the consumed submission then owes work, which gates the next. A /clear
 * card is run, never consumed: its commit wakes the step that sends the card behind it.
 */
export class StructuredAgentSessionQueuedMessageDrain {
  private readonly scheduled = new Set<string>()
  private disposed = false

  constructor(private readonly deps: QueuedMessageDrainDeps) {}

  /** Quit, with delivery: a hand-off made now could only be settled by the next process, so a
   *  quit leaves the cards exactly as a crash does. Read by the step at its start, and again
   *  right before it appends, since quit can land while it awaits. */
  dispose(): void {
    this.disposed = true
  }

  schedule(sessionId: string): void {
    const journal = this.disposed ? undefined : this.deps.sessions.get(sessionId)?.journal
    if (!journal) {
      return
    }
    // Cheap pre-check so token streams do not pay a serialized step per delta, nor child-work
    // updates one per tick while a /clear waits on them. Skipping is safe: whatever ends the work or
    // the wait is itself a commit or a wake that schedules again, and the step re-reads every gate.
    try {
      if (
        !journal.queuedMessages.settlementOwed() &&
        !structuredQueueHeadMayRun({
          journal,
          record: this.deps.getRecord(sessionId),
          fence: this.deps.conversationFence(sessionId),
          childWork: () => this.deps.readChildWork(sessionId),
          backgroundTaskStops: () => this.deps.backgroundTaskStops(sessionId),
          stoppedTaskEndingOwed: () => this.deps.stoppedTaskEndingOwed(sessionId)
        })
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
        return this.step(sessionId)
      })
      .catch((error: unknown) => {
        this.scheduled.delete(sessionId)
        this.deps.logger.warn('draining queued messages failed', {
          scope: 'queued-drain',
          sessionId,
          error
        })
      })
  }

  private async step(sessionId: string): Promise<void> {
    const session = this.deps.sessions.get(sessionId)
    if (this.disposed || !session) {
      return
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
    const next = nextStructuredQueuedMessage({
      journal,
      record,
      fence,
      childWork: () => this.deps.readChildWork(sessionId),
      backgroundTaskStops: () => this.deps.backgroundTaskStops(sessionId),
      stoppedTaskEndingOwed: () => this.deps.stoppedTaskEndingOwed(sessionId)
    })
    if (this.disposed || !next) {
      return
    }
    if (isQueuedClearCard(next)) {
      await this.deps.runClear(sessionId, next)
      return
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
          yieldsToPause: true
        }
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
        // Lost a race with a Send-now, a Delete or a Stop; their transition stands.
        return
      }
      // Pre-consume failure: the draft stays waiting, held with the marker on
      // the card (a stored fact, so it survives eviction and restart). The
      // hold's own commit notification publishes it. An explicit Send retries;
      // no automatic retry loop.
      await journal.queuedMessages
        .hold({ messageIds: [next.messageId], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
        .catch(() => {})
      throw error
    }
    this.deps.wakeDelivery(sessionId)
  }
}
