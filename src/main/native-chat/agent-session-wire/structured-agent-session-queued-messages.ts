// Drafts owe no execution work; derive delivery gates under serialization before consuming one card per turn.

import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionSendResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { createStructuredAgentSessionOperationId } from '../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import {
  contextStructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork
} from './structured-agent-session-current-work'
import {
  QueuedMessageNotConsumableError,
  QueuedMessageNotOwedError
} from '../agent-session-journal/queued-message-consume-error'
import { queuedMessageOwed } from './structured-agent-session-queued-mail'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import {
  type AgentSessionTurnContext,
  agentSessionAttachmentExpiredRefusal
} from './structured-agent-session-turns'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { captureStructuredExecutionOptions } from './structured-agent-session-execution-options'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import {
  nextStructuredQueuedMessage,
  shouldQueueStructuredAgentSessionSend
} from './structured-agent-session-queued-gate'

/** Queue eligible fresh sends; return null for immediate delivery or existing submission replay. */
export async function maybeQueueStructuredAgentSessionSend(
  context: {
    deps: { store: { getRecord: (sessionId: string) => AgentSessionRecord | null } }
  },
  ctx: Pick<
    AgentSessionTurnContext,
    | 'sessionId'
    | 'journal'
    | 'fence'
    | 'operationReceipt'
    | 'currentWork'
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
  if (
    params.delivery !== 'queue-if-active' ||
    (params.queuedImageCards === false &&
      params.body.blocks.some((block) => block.type === 'image-ref'))
  ) {
    return null
  }
  // Reconstruct queued replay by card linkage; its fresh handoff ID cannot guard this original ID.
  const queuedBefore = queuedSendAnswer(ctx.journal, clientMessageId)
  if (queuedBefore) {
    return { ok: true, value: queuedBefore }
  }
  if (ctx.journal.submission(clientMessageId)) {
    return null
  }
  if (
    !shouldQueueStructuredAgentSessionSend({
      journal: ctx.journal,
      record: context.deps.store.getRecord(ctx.sessionId),
      work: contextStructuredAgentSessionCurrentWork(ctx),
      fromAgent: !params.userSend && !params.personsMessage && params.body.from !== undefined
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
        options: captured.options,
        ...(params.userSend ? { requireAttachments: true } : {})
      },
      ctx.operationReceipt
    )
  } catch (error) {
    if (isAgentSessionAttachmentExpiredError(error)) {
      return agentSessionAttachmentExpiredRefusal(error)
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
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
  canSteer?: (sessionId: string, card: QueuedMessageRow) => boolean
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
    const record = this.deps.getRecord(sessionId)
    const work = this.deps.currentWork(sessionId)
    const next = work
      ? nextStructuredQueuedMessage({
          journal,
          record,
          work,
          steer: true,
          canSteer: this.deps.canSteer?.bind(null, sessionId)
        })
      : null
    if (this.disposed || !next) {
      return
    }
    const steer = work !== null && work.activeTurnId() !== null
    // Fresh submission IDs link drafts through queuedMessageId, never equality.
    const submissionId = createStructuredAgentSessionOperationId(randomUUID)
    const owed = queuedMessageOwed({ queuedAgentMessageOwed: this.deps.owed }, sessionId, next.body)
    try {
      await journal.appendSubmission(
        {
          clientMessageId: submissionId,
          // Automatic handoffs never become personal kept cards on close/restart.
          origin: 'host',
          payloadFingerprint: next.fingerprint,
          body: next.body,
          ...(next.options ? { options: next.options } : {}),
          fence,
          handoverRecorded: true
        },
        {
          messageId: next.messageId,
          expect: 'waiting',
          yieldsToPause: true,
          ...(steer && { steer: true }),
          ...(owed && { owed })
        },
        this.deps.submissionReceipt?.(sessionId)
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
        if (next.messageId !== journal.queuedMessages.nextInputCard(true, steer)?.messageId) {
          // The queue's choice moved (older mail became decidable): choose again.
          this.schedule(sessionId)
        }
        return
      }
      if (error instanceof QueuedMessageNotOwedError) {
        // No longer owed here: drop it without a turn; its withdrawal commit wakes the next card.
        // One that cannot be decided now keeps its place; the next wake passes over it.
        if (error.owed === 'stale') {
          await journal.queuedMessages.withdraw([next.messageId])
        } else {
          this.schedule(sessionId)
        }
        return
      }
      // Persist failed conversion as a held waiting card; only explicit Send retries, avoiding loops.
      await journal.queuedMessages
        .hold({ messageIds: [next.messageId], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
        .catch(() => {})
      throw error
    }
    this.deps.wakeDelivery(sessionId)
  }
}
