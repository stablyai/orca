// A send's queue step around its immediate path: the queue decision before it, and the card it
// writes. Its accepted turn lifts a paused queue (`queued-message-pause.ts`), not anything here.

import type {
  AgentSessionSendResult,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import {
  queuedMessageBodyIsTextOnly,
  queuedMessageBudgetRefusal,
  shouldQueueStructuredAgentSessionSend
} from './structured-agent-session-queued-messages'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import { structuredAgentSessionSendBlock } from './structured-agent-session-send-preparation'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function runQueueableStructuredAgentSessionSend(
  context: StructuredAgentSessionMutationContext,
  ctx: AgentSessionTurnContext,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
  },
  immediate: () => Promise<TurnOutcome<AgentSessionSendResult>>
): Promise<TurnOutcome<AgentSessionSendResult>> {
  // The queue decision runs first: a capable send while the session owes work (a
  // /compact included — it is a queued message like any other) becomes a draft;
  // only a `blocked` hold, which never queues, falls through to the refusal.
  const queued = await maybeQueueStructuredAgentSessionSend(context, ctx, params)
  if (queued) {
    return queued
  }
  const accepted = await immediate()
  if (accepted.ok) {
    context.wakeDelivery(ctx.sessionId)
  }
  return accepted
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
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'journal' | 'fence' | 'operationReceipt'>,
  params: {
    envelope: { clientOperationId: string }
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
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
      fence: ctx.fence
    })
  ) {
    return null
  }
  return insertQueuedSend(ctx, params)
}

type QueuedSendParams = Parameters<typeof maybeQueueStructuredAgentSessionSend>[2]

/**
 * A text send asking to be queued while a person's Stop ends the work: always a card at the end,
 * whatever the session reads by now, which that Stop's pause holds until Resume or an accepted
 * turn. A replayed id answers as it was recorded, and `blocked` refuses as the immediate path does.
 */
export async function queueStructuredAgentSessionSendAfterStop(
  context: {
    deps: { store: { getRecord: (sessionId: string) => AgentSessionRecord | null } }
  },
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'journal' | 'operationReceipt'>,
  params: QueuedSendParams
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const clientMessageId = params.envelope.clientOperationId
  const queuedBefore = queuedSendAnswer(ctx.journal, clientMessageId)
  if (queuedBefore) {
    return { ok: true, value: queuedBefore }
  }
  const submission = ctx.journal.submission(clientMessageId)
  if (submission) {
    return { ok: true, value: { clientMessageId, submission } }
  }
  return (
    structuredAgentSessionSendBlock(context.deps.store.getRecord(ctx.sessionId)) ??
    insertQueuedSend(ctx, params)
  )
}

async function insertQueuedSend(
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'journal' | 'operationReceipt'>,
  params: QueuedSendParams
): Promise<
  { ok: true; value: AgentSessionSendResult } | { ok: false; refusal: AgentSessionWireRefusal }
> {
  const clientMessageId = params.envelope.clientOperationId
  const refusal = queuedMessageBudgetRefusal(ctx.journal, params.body)
  if (refusal) {
    return { ok: false, refusal }
  }
  // The insert notifies through the journal's commit listener: publication and
  // the drain re-derive with no call here to forget.
  const row = await ctx.journal.queuedMessages.insert(
    {
      messageId: clientMessageId,
      body: params.body,
      // In the session that will send it: the reducer aliases the provider's echo by exactly this.
      fingerprint: agentSessionSendBodyFingerprint(ctx.sessionId, params.body),
      hostInstance: structuredAgentSessionHostInstance()
    },
    ctx.operationReceipt
  )
  return {
    ok: true,
    value: {
      clientMessageId,
      queued: { messageId: row.messageId, position: row.position, state: row.state }
    }
  }
}
