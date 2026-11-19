import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type {
  JournalAutomaticAdmit,
  JournalAutomaticSelection
} from '../../agent-session-journal/journal-automatic-submission'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { AgentSessionJournalError } from '../../agent-session-journal/writing/journal-write-guards'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { admitQueuedMessage } from './structured-agent-session-queued-mail'
export { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-send-admission'

export type QueuedMessageDrainDeps = {
  assertQueuedMessageAllowed?: (sessionId: string, messageId: string) => void
  getRecord: (sessionId: string) => AgentSessionRecord | null
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  conversationFence: (sessionId: string) => number
  captureSelection: (
    sessionId: string,
    journal: SqlAgentSessionJournal
  ) => Promise<JournalAutomaticSelection>
  wakeDelivery: (sessionId: string) => void
  submissionReceipt?: (sessionId: string) => JournalOperationReceipt
  queuedAgentMessageOwed?: StructuredAgentSessionHostDeps['queuedAgentMessageOwed']
  onMessageAdmitted?: StructuredAgentSessionHostDeps['onMessageAdmitted']
  logger: StructuredAgentSessionLogger
}

/** Re-derive gates per serialized step; consume at most one draft, whose submission gates the next. */
export class StructuredAgentSessionQueuedMessageDrain {
  private readonly scheduled = new Set<string>()
  private disposed = false

  constructor(private readonly deps: QueuedMessageDrainDeps) {}

  /** Quit checks disposal before the step and append so cards remain recoverable without new handoffs. */
  dispose(): void {
    this.disposed = true
  }

  schedule(sessionId: string): void {
    const journal = this.disposed ? undefined : this.deps.sessions.get(sessionId)?.journal
    if (!journal) {
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
    const fence = this.deps.conversationFence(sessionId)
    // A guarded host claims only the card its guard passed, asked within the claim's lane.
    let refused: { error: unknown } | undefined
    const admit: JournalAutomaticAdmit | undefined = this.deps.assertQueuedMessageAllowed
      ? (card) => {
          try {
            admitQueuedMessage(this.deps, sessionId, card.messageId, card.body)
            return true
          } catch (error) {
            refused = { error }
            return false
          }
        }
      : undefined
    const result = await journal.claimAutomaticSubmission(
      { clientMessageId: createStructuredAgentSessionOperationId(randomUUID), fence },
      async () => {
        const selection = await this.deps.captureSelection(sessionId, journal)
        if (this.disposed || this.deps.sessions.get(sessionId) !== session) {
          throw new AgentSessionJournalError('journal_closed', 'queued delivery was cancelled')
        }
        return selection
      },
      (source) => this.deps.queuedAgentMessageOwed?.(sessionId, source) ?? 'owed',
      this.deps.submissionReceipt?.(sessionId),
      admit
    )
    if (result.kind === 'needs-admission') {
      // A card the guard refuses is held as a failed send.
      await journal.queuedMessages.hold({
        messageIds: [result.messageId],
        reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED
      })
      throw refused?.error ?? new Error('queued message was not admitted')
    }
    if (result.kind === 'claimed') {
      const record = this.deps.getRecord(sessionId)
      if (record) {
        this.deps.onMessageAdmitted?.({
          sessionId,
          workspaceId: record.location.workspaceId,
          clientMessageId: result.clientMessageId,
          body: result.body,
          joinsRunningTurn: result.steer
        })
      }
      this.deps.wakeDelivery(sessionId)
    } else if (result.kind === 'failed') {
      throw restoreJournalSqlFailure(result.failure)
    }
  }
}
