// Drafts owe no execution work; derive delivery gates under serialization before consuming one card per turn.

import { randomUUID } from 'node:crypto'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  QUEUED_MESSAGE_PAUSED_SEND_FAILED,
  type AgentSessionSendResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { createStructuredAgentSessionOperationId } from '../../../shared/structured-agent-session-mutation'
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
import { QueuedMessageNotConsumableError } from '../agent-session-journal/queued-message-consume-error'
import type { QueuedMessageRow } from '../agent-session-journal/queued-message-table'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { agentSessionAttachmentExpiredRefusal } from './structured-agent-session-turns'
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
  input: StructuredQueueGateInput & { journal: AgentSessionJournal }
): QueuedMessageRow | null {
  if (structuredInputExecutionWorking(input.journal, input.work)) {
    return null
  }
  const selected = selectStructuredAgentSessionInput(input.journal)
  const next = selected.kind === 'card' ? selected.card : null
  // Check cheap working state before the prompt scan on every streamed frame.
  if (next === null) {
    return null
  }
  return !input.record ||
    structuredAgentSessionSendBlock(input.record) ||
    input.work.hasActionablePrompt()
    ? null
    : next
}

/** Queue behind work/actionable backlog; held or returned cards cannot trap a fresh send that lifts their pause. */
export function shouldQueueStructuredAgentSessionSend(
  input: StructuredQueueGateInput & { journal: AgentSessionJournal }
): boolean {
  const hold = structuredQueueHold(input)
  if (hold === 'blocked') {
    // Return immediate refusal; queueing behind a blocked session would strand the draft.
    return false
  }
  if (hold !== null) {
    return true
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
        { messageId: next.messageId, expect: 'waiting', yieldsToPause: true },
        this.deps.submissionReceipt?.(sessionId)
      )
    } catch (error) {
      if (error instanceof QueuedMessageNotConsumableError) {
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
