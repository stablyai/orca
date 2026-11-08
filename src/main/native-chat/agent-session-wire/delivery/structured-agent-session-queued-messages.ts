// Drafts owe no execution work; derive delivery gates under serialization before consuming one card per turn.

import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionSendResult } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { createStructuredAgentSessionOperationId } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import { readContextStructuredAgentSessionWork } from '../observations/structured-agent-session-read-work'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { contextStructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'
import type { QueuedMessageRow } from '../../agent-session-journal/queued-messages/queued-message-table'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import {
  type AgentSessionTurnContext,
  agentSessionAdmissionWriteRefusal
} from '../operations/structured-agent-session-turns'
import { captureStructuredExecutionOptions } from '../options/structured-agent-session-execution-options'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import { shouldQueueStructuredAgentSessionSend } from './structured-agent-session-queued-gate'
import type { JournalAutomaticSelection } from '../../agent-session-journal/journal-automatic-submission'
import type { SqlAgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import { restoreJournalSqlFailure } from '../../agent-session-journal/journal-sql-failure'
import { AgentSessionJournalError } from '../../agent-session-journal/writing/journal-write-guards'

/** Queue eligible fresh sends; return null for immediate delivery or existing submission replay. */
export async function maybeQueueStructuredAgentSessionSend(
  context: {
    deps: { store: { getRecord: (sessionId: string) => AgentSessionRecord | null } }
  },
  ctx: Pick<
    AgentSessionTurnContext,
    | 'sessionId'
    | 'logger'
    | 'journal'
    | 'fence'
    | 'operationReceipt'
    | 'currentWork'
    | 'readWork'
    | 'agents'
    | 'agent'
    | 'persistedOptions'
  >,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
    queuedImageCards?: boolean
    options?: Readonly<Record<string, string>>
    selection?: Readonly<Record<string, string>>
    /** A person's send at a chat surface: every attachment it names must still be stored. */
    userSend?: true
    personsMessage?: true
  }
): Promise<
  | { ok: true; value: AgentSessionSendResult }
  | { ok: false; refusal: AgentSessionWireRefusal }
  | null
> {
  const clientMessageId = params.envelope.clientOperationId
  // Reconstruct queued replay by card linkage; its fresh handoff ID cannot guard this original ID.
  const queuedBefore = await queuedSendAnswer(ctx.journal, clientMessageId)
  if (queuedBefore) {
    return { ok: true, value: queuedBefore }
  }
  if (await ctx.journal.reads.submission(clientMessageId)) {
    return null
  }
  if (
    !(await shouldQueueStructuredAgentSessionSend({
      journal: ctx.journal,
      record: context.deps.store.getRecord(ctx.sessionId),
      work: await contextStructuredAgentSessionCurrentWork(ctx),
      readWork: (operation) => readContextStructuredAgentSessionWork(ctx, operation),
      fromAgent: !params.userSend && !params.personsMessage && params.body.from !== undefined
    }))
  ) {
    return null
  }
  const refusal = await queuedMessagesPublishedBytesRefusal(
    ctx.journal,
    params.body,
    params.userSend === true || params.personsMessage === true
  )
  if (refusal) {
    return { ok: false, refusal }
  }
  const captured = captureStructuredExecutionOptions(ctx, params.options, params.selection)
  if ('refusal' in captured) {
    return { ok: false, refusal: captured.refusal }
  }
  // Journal commit listeners publish and wake drain automatically.
  let row: QueuedMessageRow
  try {
    row = await ctx.journal.queuedMessages.insert(
      {
        messageId: clientMessageId,
        body: params.body,
        deliveryMode: params.delivery === 'queue-if-active' ? 'queue' : 'steer',
        unattended: !params.userSend && !params.personsMessage,
        options: captured.options,
        ...(params.userSend ? { requireAttachments: true } : {})
      },
      ctx.operationReceipt
    )
  } catch (error) {
    return agentSessionAdmissionWriteRefusal(ctx, error)
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
    } else if (result.kind === 'changed' && result.retry) {
      this.schedule(sessionId)
    } else if (result.kind === 'failed') {
      throw restoreJournalSqlFailure(result.failure)
    }
  }
}
