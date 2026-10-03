// Everything a client can ask a session to do: send a turn, cancel one, answer a prompt, change an
// option, read the options back.
//
// They share one shape — admit the envelope against the lease, run a plan, publish the journal — so
// they share one path here rather than five copies in the host. The host keeps attach and teardown.
// Each opens the conversation first. A send, a Stop and an option pick are conversation writes,
// admitted without the writer lease; the delivery loop starts the provider child a send needs, and
// an operation only the provider can perform starts it before admission.

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionPromptResult,
  AgentSessionSendResult,
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session-wire'
import type { AgentSessionPromptRequest } from './structured-agent-session-turns-prompt'
import { threadGoalPlan } from './structured-agent-session-thread-goal'
import {
  mutateStructuredAgentSession,
  mutateStructuredAgentSessionOffLane,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import {
  maybeQueueStructuredAgentSessionSend,
  queuedMessageBodyIsTextOnly
} from './structured-agent-session-queued-messages'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-admission'
import {
  openForProviderWrite,
  openWithAgent,
  sendPreparation,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan
} from './structured-agent-session-mutation-plans'
import { runQueueableStructuredAgentSessionSend } from './structured-agent-session-queued-send'
import { cancelStructuredAgentSessionPrompt } from './structured-agent-session-prompt-cancel'
import { mutateWithChatStop } from './structured-agent-session-chat-stop'
export type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'

export function sendStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    retryUnknown?: true
    delivery?: 'queue-if-active'
    /** Host-local, set only by the client-facing `agentSession.send` RPC (the
     *  renderer's launch prompt included): recorded as the submission's `client`
     *  origin, whose started turn ends a Stop's or a restart's queue pause.
     *  Orchestration mail, a restart continuation and `agent.launch`'s host-sent
     *  prompt never set it. */
    userSend?: true
    beforeRun?: () => void
  }
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const plan = sendPlan(params)
  const preparation = sendPreparation(context, params.envelope)
  const queueable = (ctx: AgentSessionTurnContext) =>
    runQueueableStructuredAgentSessionSend(
      context,
      ctx,
      params,
      async () =>
        structuredAgentSessionSendBlock(context.deps.store.getRecord(ctx.sessionId)) ??
        (await plan.run(ctx))
    )
  if (!sendQueuesAfterStop(context, params)) {
    return mutateStructuredAgentSession(
      context,
      caller,
      params.envelope,
      { ...plan, run: queueable },
      preparation
    )
  }
  // A message sent while a person's Stop ends the work is a card that runs once the stop lands. Its
  // write has no order to keep with the Stop, which holds the lane until its provider answers.
  return mutateStructuredAgentSessionOffLane(context, caller, params.envelope, {
    ...plan,
    run: async (ctx) => {
      // Read again once admitted, in the same tick as the write: the Stop may have settled since.
      const queued = sendQueuesAfterStop(context, params)
        ? await maybeQueueStructuredAgentSessionSend(context, ctx, params, true)
        : null
      return (
        queued ??
        // Anything else takes the lane, on the conversation and fence it stands at there, as every
        // send does: a close and reopen while it waited replaced the journal admission read.
        context.serialize(ctx.sessionId, async () => {
          const prepared = await preparation()
          const journal = context.sessions.get(ctx.sessionId)?.journal
          if (!prepared.ok || !journal) {
            return prepared.ok
              ? { ok: false as const, refusal: AGENT_SESSION_NOT_ATTACHED }
              : prepared
          }
          const fence = context.deps.store.getRecord(ctx.sessionId)?.lease.runtimeFence
          return queueable({ ...ctx, journal, fence: fence ?? ctx.fence })
        })
      )
    }
  })
}

/** A text send asking to be queued, while the host reads that a person's Stop is ending the work. */
function sendQueuesAfterStop(
  context: StructuredAgentSessionMutationContext,
  params: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    delivery?: 'queue-if-active'
  }
): boolean {
  return (
    params.delivery === 'queue-if-active' &&
    queuedMessageBodyIsTextOnly(params.body) &&
    context.readStopping?.(params.envelope.sessionId) === true
  )
}

export function cancelStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    turnId?: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
  }
): Promise<AgentSessionMutationResult<AgentSessionCancelResult>> {
  if (params.scope) {
    return mutateStructuredAgentSession(
      context,
      caller,
      params.envelope,
      cancelPlan({ ...params, childWork: () => context.readChildWork(params.envelope.sessionId) }),
      openForProviderWrite(context, params.envelope)
    )
  }
  const plan = cancelPlan(params)
  const { prompt } = params
  // A card's Cancel stops whatever the chat has in flight, as the Stop button does; it reaches the
  // Stop only for a card the live turn raised (`cancelStructuredAgentSessionPrompt`).
  const stopped = prompt ? { envelope: params.envelope } : params
  return mutateWithChatStop(context, caller, stopped, plan, (ctx, stop) =>
    prompt
      ? cancelStructuredAgentSessionPrompt(
          ctx,
          { ...(params.turnId !== undefined ? { turnId: params.turnId } : {}), prompt },
          { stop, interrupt: () => plan.run(ctx) }
        )
      : stop().then(({ outcome }) => outcome)
  )
}

export function respondToStructuredAgentSessionPrompt(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: AgentSessionPromptRequest & { envelope: AgentSessionMutationEnvelope }
): Promise<AgentSessionMutationResult<AgentSessionPromptResult>> {
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    promptPlan(params),
    openForProviderWrite(context, params.envelope)
  )
}

export async function setStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; key: string; value: string }
): Promise<AgentSessionMutationResult<AgentSessionOptionResult>> {
  // Outside the queue: a pick made while the provider starts then queues behind what its start persists.
  await context.deps.adapter.awaitOptionWritable?.(params.envelope.sessionId)
  const plan = setOptionPlan(params)
  const atRest = () => !context.sessions.get(params.envelope.sessionId)?.child
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      // Read as the call is admitted: with no child running, the pick is a conversation write —
      // intent the next start replays. A running child's pick is still its owner's to make.
      get conversationWrite() {
        return atRest() ? (true as const) : undefined
      },
      run: (ctx) =>
        atRest()
          ? recordStructuredAgentSessionOptionIntent(context.deps.store, ctx, params)
          : plan.run(ctx)
    },
    openForProviderWrite(context, params.envelope)
  )
}

export function changeStructuredAgentSessionThreadGoal(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; change: AgentSessionThreadGoalChange }
): Promise<AgentSessionMutationResult<AgentSessionThreadGoalResult>> {
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    threadGoalPlan(params),
    openWithAgent(context, params.envelope)
  )
}

/** The host's thin mutation surface. Each call re-reads the context, so a session
 *  map or fence that moves between calls is never captured by a stale closure. */
export function structuredAgentSessionMutationDelegates(
  context: () => StructuredAgentSessionMutationContext
) {
  return {
    cancel: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof cancelStructuredAgentSessionTurn>[2]
    ) => cancelStructuredAgentSessionTurn(context(), caller, params),
    respondToPrompt: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof respondToStructuredAgentSessionPrompt>[2]
    ) => respondToStructuredAgentSessionPrompt(context(), caller, params),
    setOption: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof setStructuredAgentSessionOption>[2]
    ) => setStructuredAgentSessionOption(context(), caller, params),
    changeThreadGoal: (
      caller: StructuredAgentSessionCaller,
      params: Parameters<typeof changeStructuredAgentSessionThreadGoal>[2]
    ) => changeStructuredAgentSessionThreadGoal(context(), caller, params),
    readOptions: (sessionId: string) => readStructuredAgentSessionOptions(context(), sessionId)
  }
}
