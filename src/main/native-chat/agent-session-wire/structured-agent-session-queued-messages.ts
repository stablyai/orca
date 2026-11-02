// Drafts owe no execution work; derive delivery gates under serialization before consuming one card per turn.

import { journalInputOrder } from '../agent-session-journal/journal-input-order'
import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { AgentSessionSendResult } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { createStructuredAgentSessionOperationId } from '../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import { queuedMessagesPublishedBytesRefusal } from './structured-agent-session-queued-published-bytes'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
  selectStructuredAgentSessionInput,
  structuredInputExecutionWorking
} from './structured-agent-session-input-selection'

/** Preserve order and holds; only automatic drain stops at edit leases, which still count as admission backlog. */
function oldestActionableQueuedMessage(
  journal: Pick<AgentSessionJournal, 'queuedMessages'>,
  automatic: boolean
): QueuedMessageRow | null {
  return journal.queuedMessages.nextInputCard(automatic)
}

/** Host-local gate shared by admission, drain and Send-now; only Send-now overrides working. */
export type StructuredQueueHold = 'blocked' | 'working' | 'prompt'

/** Ended-generation leftovers must not hold the queue. */
export type StructuredQueueGateInput = {
  record: AgentSessionRecord | null
  work: StructuredAgentSessionCurrentWork
}

export function structuredQueueHold(input: StructuredQueueGateInput): StructuredQueueHold | null {
  if (!input.record || structuredAgentSessionSendBlock(input.record)) {
    return 'blocked'
  }
  // Prompts outrank working because Send-now cannot override them.
  if (input.work.hasActionablePrompt()) {
    return 'prompt'
  }
  return input.work.working() ? 'working' : null
}

/** Publish the drain’s live pick; backlog itself never gates a lone draft. */
export function nextStructuredQueuedMessage(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal; working?: boolean }
): QueuedMessageRow | null {
  // Every gate before the queue is asked: choosing a card can read mail authority, and a session
  // that is working, blocked or waiting on a prompt can send nothing anyway. An empty queue has
  // nothing to choose, so it never reads the prompt either.
  const state = input.journal.queuedMessages.inputState()
  const cards = journalInputOrder(state).cards
  cards.ensure(state)
  if (
    (input.working ?? structuredInputExecutionWorking(input.journal, input.work)) ||
    !input.record ||
    structuredAgentSessionSendBlock(input.record) ||
    !cards.head() ||
    input.work.hasActionablePrompt()
  ) {
    return null
  }
  const selected = selectStructuredAgentSessionInput(input.journal)
  return selected.kind === 'card' ? selected.card : null
}

/** Queue behind work/actionable backlog; held or returned cards cannot trap a fresh send that lifts their pause. */
export function shouldQueueStructuredAgentSessionSend(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal; fromAgent?: boolean }
): boolean {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // Return immediate refusal; queueing behind a blocked session would strand the draft.
    return false
  }
  if (hold !== null) {
    return true
  }
  if (input.fromAgent) {
    // Only the person's own send recovers a failed turn; another agent's message waits held with the rest.
    const state = input.journal.queuedMessages.inputState()
    const cards = journalInputOrder(state).cards
    cards.ensure(state)
    if (cards.failureHolds()) {
      return true
    }
  }
  return oldestActionableQueuedMessage(input.journal, false) !== null
}

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
  currentWork: (sessionId: string) => StructuredAgentSessionCurrentWork | null
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
    // Skip serialized work during token streams; settlement/generation-end schedules a fresh gate check.
    try {
      const work = this.deps.currentWork(sessionId)
      if (
        !work ||
        nextStructuredQueuedMessage({ journal, record: this.deps.getRecord(sessionId), work }) ===
          null
      ) {
        return
      }
    } catch {
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
    const next = work ? nextStructuredQueuedMessage({ journal, record, work }) : null
    if (this.disposed || !next) {
      return
    }
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
          ...(owed && { owed })
        },
        this.deps.submissionReceipt?.(sessionId)
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
        if (next.messageId !== journal.queuedMessages.nextInputCard()?.messageId) {
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
