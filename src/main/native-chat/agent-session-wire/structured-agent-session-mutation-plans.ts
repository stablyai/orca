// One plan per mutating method: what it fingerprints, what it does, and how its
// answer is rebuilt on a replay.
//
// The replay half matters more than it looks. The ledger records only that an
// operation happened, so the durable answer usually comes back out of the
// journal. Send is fail-closed: admission alone cannot prove non-delivery, so
// its success commits with the row that accepts it, and a row still pending is
// one that wrote nothing.

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
  performCancel,
  performPrompt,
  performSend,
  performSetOption,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'
import type { AgentSessionPromptRequest } from './structured-agent-session-turns-prompt'
import { queuedSendAnswer } from './structured-agent-session-queued-send-answer'

export type MutationPlan<TValue> = {
  method: string
  fields: Record<string, unknown>
  operationIdScope?: 'global'
  /** Admitted without the writer lease: see `admitAgentSessionMutation`. */
  conversationWrite?: true
  /** Still runs, decided from the committed ledger, when its ledger row cannot be written. */
  runsWithoutLedgerRow?: true
  run: (ctx: AgentSessionTurnContext) => Promise<TurnOutcome<TValue>>
  replay: (ctx: AgentSessionTurnContext, outcome: AgentSessionOperationOutcome) => TValue | null
  rerunWhenReplayMissing?: (ctx: AgentSessionTurnContext) => boolean
  recoverUnknownFromDurableState?: boolean
} & (
  | {
      /** Its success is the row its run writes, so it commits in that row's transaction
       *  (`AgentSessionTurnContext.operationReceipt`): a row left pending wrote nothing. That
       *  success is fixed before the value exists, so it records no `settledOutcome`. */
      settlesWithWrite: true
      settledOutcome?: never
    }
  | {
      settlesWithWrite?: never
      settledOutcome?: (value: TValue) => AgentSessionOperationOutcome
    }
)

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
    settlesWithWrite: true,
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
  /** What an older build's run of this operation recorded. */
  | { recorded: AgentSessionConversationCommandResult }

/** `/compact` accepted like a send: one submission, keyed by the operation id, that the delivery
 *  loop carries out as the command's own turn. */
export function conversationCommandPlan(params: {
  envelope: AgentSessionMutationEnvelope
  priorRecord: () => AgentSessionConversationCommandResult | null
}): MutationPlan<ConversationCommandAcceptance> {
  const clientMessageId = params.envelope.clientOperationId
  return {
    method: 'agentSession.conversationCommand',
    conversationWrite: true,
    settlesWithWrite: true,
    fields: { command: STRUCTURED_AGENT_SESSION_COMPACT_COMMAND },
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
    replay: (ctx, outcome) => {
      if (outcome.status === 'succeeded' && outcome.conversationCommand) {
        return { recorded: outcome.conversationCommand }
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
  return {
    method: 'agentSession.cancel',
    // Stop is a conversation write; a prompt or background-task cancel needs the live child.
    ...(params.scope || params.prompt ? {} : { conversationWrite: true as const }),
    // A Stop must reach the agent even when storage refuses the row recording it.
    runsWithoutLedgerRow: true,
    fields: {
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {})
    },
    run: (ctx) =>
      performCancel(ctx, {
        clientOperationId: params.envelope.clientOperationId,
        ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(params.childWork ? { childWork: params.childWork } : {})
      }),
    // Interrupting twice would kill a turn the client never asked to stop, so a
    // replay reports the turn as already handled.
    replay: () => ({
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      cancelled: false
    })
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
    run: (ctx) => performPrompt(ctx, params),
    replay: (ctx) => {
      const item = ctx.journal.snapshot().items.find((entry) => entry.itemId === params.itemId)
      const body = item?.body
      if (!item || !body || (body.kind !== 'approval' && body.kind !== 'question')) {
        return null
      }
      return body.resolution.state === 'pending'
        ? null
        : { itemId: item.itemId, revision: item.revision, resolution: body.resolution }
    }
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
