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
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
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
  setOptionPlan,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import { agentSessionMutationAdmitsNow } from './structured-agent-session-mutation-admits-now'
import { runQueueableStructuredAgentSessionSend } from './structured-agent-session-queued-send'
import { cancelStructuredAgentSessionPrompt } from './structured-agent-session-prompt-cancel'
import { mutateWithChatStop } from './structured-agent-session-chat-stop'
import { performSetOption } from './structured-agent-session-turns-options'
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
     *  origin, so a restart or a close keeps it as a card if it never reached the
     *  agent. Orchestration mail, a restart continuation and `agent.launch`'s host-sent
     *  prompt never set it. */
    userSend?: true
    /** Host-local, never on the wire: a person's message the host sends for them, such as a
     *  launch's first prompt. `userSend` is always one; another agent's message carries `from`. */
    personsMessage?: true
    beforeRun?: () => void
  },
  arrival?: Parameters<typeof sendPreparation>[2]
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const plan = sendPlan(params)
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      run: (ctx) =>
        runQueueableStructuredAgentSessionSend(
          context,
          ctx,
          params,
          async () =>
            structuredAgentSessionSendBlock(context.deps.store.getRecord(ctx.sessionId)) ??
            (await plan.run(ctx))
        )
    },
    sendPreparation(context, params.envelope, arrival)
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
  if (!prompt && params.turnId === undefined) {
    abortAcquireForStop(context, caller, params.envelope, plan)
  }
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

/** A Stop must not wait behind a start the provider may never answer: the start the session's
 *  queue is waiting on stops now, as a close's does, and the Stop's own step then finds no child.
 *  Only a Stop admission would run now; one naming a turn is about a child already gone, so it
 *  leaves a newer start alone. */
function abortAcquireForStop(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<AgentSessionCancelResult>
): void {
  const { store } = context.deps
  if (
    !agentSessionMutationAdmitsNow({
      store,
      callerKey: caller.callerKey,
      envelope,
      plan,
      now: context.now
    })
  ) {
    return
  }
  context.acquireAborts.abort(envelope.sessionId, 'stopped while starting')
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
      run: async (ctx) => {
        if (atRest()) {
          return recordStructuredAgentSessionOptionIntent(context.deps, ctx, params)
        }
        // Held where a start is, so a close, a Stop admitted now or quit ends the wait from outside.
        const wait = context.acquireAborts.begin(params.envelope.sessionId)
        try {
          return await performSetOption(ctx, params, wait.signal)
        } finally {
          wait.end()
        }
      }
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
