// One plan per mutating method: what it fingerprints, what it does, and how its
// answer is rebuilt on a replay.
//
// A plan with `commandReceipt` proves acceptance by that receipt, the rest by their ledger row. A
// prompt answer's replay answers from the resolution its receipt keeps; the journal projects the
// others' current answer.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  AGENT_MESSAGE_SOURCE,
  USER_MESSAGE_SOURCE,
  type AgentSessionMessageSource
} from '../../../shared/agent-session-message-source'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionOperationOutcome } from '../../../shared/agent-session-operation-ledger'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionOptionResult,
  AgentSessionPromptResult,
  AgentSessionQueuedSendReceipt,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionConversationCommandResult } from '../../../shared/agent-session-conversation-command'
import { DISPATCH_DOUBT_SUBMISSION_MISSING } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import {
  agentSessionMessagePayload,
  agentSessionSendBodyFingerprint
} from '../../../shared/structured-agent-session-send-mutation'
import {
  STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
  structuredAgentSessionCompactBody
} from './structured-agent-session-command-turn'
import {
  performPrompt,
  performSend,
  performSetOption,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'
import {
  acceptedPromptAnswer,
  promptAnswerReceipt,
  promptRowAnswer,
  type AgentSessionPromptRequest
} from './structured-agent-session-turns-prompt'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'
import { STOP_COMMAND_RECEIPT } from './structured-agent-session-stop-acceptance'
import { runTargetedCancel } from './structured-agent-session-targeted-cancel'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { CommandReceiptResult } from '../agent-session-journal/command-receipt-schema'
import type { JournalRow } from '../agent-session-journal/journal-row-schema'

export type MutationPlan<TValue> = {
  method: string
  fields: Record<string, unknown>
  operationIdScope?: 'global'
  /** Admitted without the writer lease: see `admitAgentSessionMutation`. */
  conversationWrite?: true
  run: (ctx: AgentSessionTurnContext) => Promise<TurnOutcome<TValue>>
  /** `receipt`: the accepted command receipt's result, for a plan with `commandReceipt`. */
  replay: (
    ctx: AgentSessionTurnContext,
    outcome: AgentSessionOperationOutcome,
    receipt?: CommandReceiptResult
  ) => TValue | null
  rerunWhenReplayMissing?: (ctx: AgentSessionTurnContext) => boolean
  recoverUnknownFromDurableState?: boolean
} & (
  | {
      commandReceipt: MutationCommandReceipt<TValue>
      settlesWithWrite?: never
      successReceipt?: never
      settledOutcome?: never
    }
  | {
      /** Commits success with its row; paths without a committed receipt use fallback settlement. */
      settlesWithWrite: true
      commandReceipt?: never
      successReceipt?: () => JournalOperationReceipt
      settledOutcome?: (value: TValue) => AgentSessionOperationOutcome
    }
  | {
      settlesWithWrite?: never
      commandReceipt?: never
      settledOutcome?: (value: TValue) => AgentSessionOperationOutcome
    }
)

/** Accepted through its own command receipt, inserted if absent in the transaction of its effect. */
export type MutationCommandReceipt<TValue> = {
  /** Inside the effect's transaction: the journal row it wrote, or none for a draft-table write. */
  result: (row: JournalRow | undefined) => CommandReceiptResult
  /** A run that wrote nothing: the receipt committed alone, before the answer goes out (a no-op's
   *  answer, or the earlier write it acknowledged), or null to record nothing. */
  unwritten?: (value: TValue, ctx: AgentSessionTurnContext) => CommandReceiptResult | null
}

/** The journal row an accepted command wrote, which must be of a kind it accepts with. */
export function journalRowReceiptResult(
  row: JournalRow | undefined,
  ...kinds: JournalRow['kind'][]
): CommandReceiptResult {
  if (!row || !kinds.includes(row.kind)) {
    throw new Error(`an accepted command requires its ${kinds.join(' or ')} row`)
  }
  return { kind: 'journal-row', epoch: row.epoch, sequence: row.seq }
}

/** A send accepts with its submission, or a draft held while the agent works, keyed by its id. */
function submissionOrDraftReceipt<TValue>(clientMessageId: string): MutationCommandReceipt<TValue> {
  return {
    result: (row) =>
      row
        ? journalRowReceiptResult(row, 'submission')
        : { kind: 'queued-draft', messageId: clientMessageId }
  }
}

/** Who a send is from, read off what it carries, the one place it is decided: the person's own
 *  send, another agent's message (its body names the sender), or neither, such as a dispatch
 *  preamble or a restart continuation. */
function sendSource(params: {
  body: AgentJournalMessageItem
  userSend?: true
  personsMessage?: true
}): AgentSessionMessageSource | undefined {
  if (params.userSend || params.personsMessage) {
    return USER_MESSAGE_SOURCE
  }
  return params.body.from ? AGENT_MESSAGE_SOURCE : undefined
}

export function sendPlan(params: {
  envelope: AgentSessionMutationEnvelope
  body: AgentJournalMessageItem
  retryUnknown?: true
  delivery?: 'queue-if-active'
  userSend?: true
  /** A person's message the host sends for them; `userSend` is always one. */
  personsMessage?: true
  beforeRun?: () => void
}): MutationPlan<AgentSessionSendResult> {
  // The operation id IS the client message id: one send, one durable row, one
  // key the client reconciles its optimistic bubble against.
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.send',
    operationIdScope: 'global',
    conversationWrite: true,
    commandReceipt: submissionOrDraftReceipt(clientMessageId),
    // `delivery` joins the OPERATION fingerprint only; the submission row keeps
    // the body-only fingerprint the reducer's echo-aliasing recomputes.
    fields: {
      body: agentSessionMessagePayload(params.body),
      ...(params.delivery ? { delivery: params.delivery } : {})
    },
    recoverUnknownFromDurableState: true,
    // `retryUnknown` is a compatibility-only client signal. A recorded send
    // always replays and never reaches the provider twice.
    run: (ctx) => {
      // Asked at acceptance: a send accepted after this one is queued behind it.
      params.beforeRun?.()
      const source = sendSource(params)
      return performSend(ctx, {
        origin: params.userSend ? 'client' : 'host',
        ...(source ? { source } : {}),
        clientMessageId,
        // Body-only, so the reducer's echo aliasing never sees control fields or the sender.
        payloadFingerprint: agentSessionSendBodyFingerprint(params.envelope.sessionId, params.body),
        body: params.body
      })
    },
    replay: (ctx, outcome) => {
      // A send this host queued answers from its draft, then its hand-off; a
      // withdrawn draft replays as spent — never as missing-submission doubt. Only a send that
      // asked to be queued may get that answer: a direct send the host kept as a card answers
      // from its own submission, which a client that never sent `delivery` can read.
      const queued =
        params.delivery === 'queue-if-active'
          ? queuedSendAnswer(ctx.journal, clientMessageId)
          : null
      if (queued) {
        return queued
      }
      const submission = ctx.journal
        .submissions()
        .find((entry) => entry.clientMessageId === clientMessageId)
      if (submission) {
        return { clientMessageId, submission }
      }
      // A pending row wrote nothing, so the send runs for the first time. Succeeded: accepted,
      // then a new epoch dropped its row. Unknown: only builds before this one wrote that.
      if (outcome.status === 'failed' || outcome.status === 'pending') {
        return null
      }
      const resolvedAt = ctx.now()
      return {
        clientMessageId,
        submission: {
          clientMessageId,
          fence: ctx.fence,
          payloadFingerprint: params.envelope.payloadFingerprint,
          dispatchState: 'unknown',
          providerItemId: null,
          reason: DISPATCH_DOUBT_SUBMISSION_MISSING,
          submittedAt: resolvedAt,
          resolvedAt,
          recovered: true
        }
      }
    }
  }
}

export type ConversationCommandAcceptance =
  | { clientMessageId: string }
  /** Held as a card, keyed by the operation id, behind work in flight. */
  | { queued: AgentSessionQueuedSendReceipt }
  /** What an older build's run of this operation recorded. */
  | { recorded: AgentSessionConversationCommandResult }

/** `/compact` accepted like a send: one submission, keyed by the operation id, that the delivery
 *  loop carries out as the command's own turn — or, asked with `delivery`, a card while the
 *  agent works, which the queue's drain turns into that submission. */
export function conversationCommandPlan(params: {
  envelope: AgentSessionMutationEnvelope
  delivery?: 'queue-if-active'
  priorRecord: () => AgentSessionConversationCommandResult | null
}): MutationPlan<ConversationCommandAcceptance> {
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.conversationCommand',
    operationIdScope: 'global',
    conversationWrite: true,
    commandReceipt: submissionOrDraftReceipt(clientMessageId),
    fields: {
      command: STRUCTURED_AGENT_SESSION_COMPACT_COMMAND,
      ...(params.delivery ? { delivery: params.delivery } : {})
    },
    recoverUnknownFromDurableState: true,
    run: async (ctx) => {
      const sent = await performSend(ctx, {
        clientMessageId,
        // Only a client asks through the command RPC: the person's own turn.
        origin: 'client',
        source: USER_MESSAGE_SOURCE,
        payloadFingerprint: params.envelope.payloadFingerprint,
        body: structuredAgentSessionCompactBody()
      })
      return sent.ok ? { ok: true, value: { clientMessageId } } : sent
    },
    replay: (ctx) => {
      // A card answers from itself until drained, then from the submission it became; only a
      // command that asked to wait can have one, as for a send.
      const queued =
        params.delivery === 'queue-if-active'
          ? queuedSendAnswer(ctx.journal, clientMessageId)
          : null
      if (queued) {
        return 'queued' in queued
          ? { queued: queued.queued }
          : { clientMessageId: queued.submission.clientMessageId }
      }
      if (ctx.journal.submissions().some((entry) => entry.clientMessageId === clientMessageId)) {
        return { clientMessageId }
      }
      const prior = params.priorRecord()
      return prior ? { recorded: prior } : null
    }
  }
}

export function cancelPlan(params: {
  envelope: AgentSessionMutationEnvelope
  turnId?: string
  scope?: 'background-tasks'
  taskId?: string
  prompt?: { itemId: string; expectedRevision: number }
  /** The session's child records, which name the tasks a background Stop reaches. */
  childWork?: () => readonly AgentChildWorkView[] | undefined
}): MutationPlan<AgentSessionCancelResult> {
  const named = params.turnId !== undefined ? { turnId: params.turnId } : {}
  return {
    method: 'agentSession.cancel',
    // Stop is a conversation write; a prompt or background-task cancel needs the live child.
    ...(params.scope || params.prompt ? {} : { conversationWrite: true as const }),
    // Saved before it acts: a Stop whose acceptance cannot be saved interrupts nothing.
    commandReceipt: STOP_COMMAND_RECEIPT,
    fields: {
      ...named,
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {})
    },
    // The chat's own Stop runs through `mutateWithChatStop`; this is a background-task stop's and a
    // prompt card's interrupt.
    run: (ctx) =>
      runTargetedCancel(ctx, { ...params, clientOperationId: params.envelope.clientOperationId }),
    // A retry acknowledges the Stop it repeats and never stops anything again: interrupting twice
    // would stop a turn the client never asked to stop.
    replay: () => ({ ...named, cancelled: false })
  }
}

export function promptPlan(
  params: AgentSessionPromptRequest
): MutationPlan<AgentSessionPromptResult> {
  return {
    method: `agentSession.respondTo:${params.kind}`,
    // The client hashes exactly what it sent; the absent one of these two drops out of the digest.
    fields: {
      itemId: params.itemId,
      expectedRevision: params.expectedRevision,
      optionId: params.optionId,
      answers: params.answers
    },
    // The resolved revision's answer, or the answer the prompt already held, kept in the receipt.
    commandReceipt: {
      result: (row) => promptAnswerReceipt(promptRowAnswer(row)),
      unwritten: (value) => promptAnswerReceipt(value)
    },
    run: (ctx) => performPrompt(ctx, params),
    replay: (_ctx, _outcome, receipt) => acceptedPromptAnswer(receipt)
  }
}

export function setOptionPlan(params: {
  key: string
  value: string
}): MutationPlan<AgentSessionOptionResult> {
  return {
    method: 'agentSession.setOption',
    fields: { key: params.key, value: params.value },
    run: (ctx) => performSetOption(ctx, params),
    // A pending row may have crashed before the adapter call. Reapplying the
    // same assignment is safe; only a settled success can be answered directly.
    replay: (ctx, outcome) =>
      outcome.status === 'succeeded'
        ? {
            key: params.key,
            value: params.value,
            ...(ctx.persistedOptions ? { options: { ...ctx.persistedOptions } } : {})
          }
        : null
  }
}
