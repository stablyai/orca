import { randomUUID } from 'node:crypto'
import { createStructuredAgentSessionOperationId } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type { JournalAutomaticSelection } from '../../agent-session-journal/journal-automatic-submission'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { AgentSessionJournalError } from '../../agent-session-journal/writing/journal-write-guards'
export { maybeQueueStructuredAgentSessionSend } from './structured-agent-session-send-admission'

export type QueuedMessageDrainDeps = {
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  conversationFence: (sessionId: string) => number
  captureSelection: (
    sessionId: string,
    journal: SqlAgentSessionJournal
  ) => Promise<JournalAutomaticSelection>
  wakeDelivery: (sessionId: string) => void
  submissionReceipt?: (sessionId: string) => JournalOperationReceipt
  owed?: StructuredAgentSessionHostDeps['queuedAgentMessageOwed']
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
    const result = await journal.claimAutomaticSubmission(
      { clientMessageId: createStructuredAgentSessionOperationId(randomUUID), fence },
      async () => {
        const selection = await this.deps.captureSelection(sessionId, journal)
        if (this.disposed || this.deps.sessions.get(sessionId) !== session) {
          throw new AgentSessionJournalError('journal_closed', 'queued delivery was cancelled')
        }
        return selection
      },
      (source) => this.deps.owed?.(sessionId, source) ?? 'owed',
      this.deps.submissionReceipt?.(sessionId)
    )
    if (result.kind === 'claimed') {
      this.deps.wakeDelivery(sessionId)
    } else if (result.kind === 'failed') {
      throw restoreJournalSqlFailure(result.failure)
    }
  }
}
