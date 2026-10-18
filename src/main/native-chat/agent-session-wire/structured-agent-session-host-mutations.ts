// Everything a client can ask a session to do: send a turn, cancel one, answer a prompt, change an
// option, read the options back.
//
// They share one shape — admit the envelope against the lease, run a plan, publish the journal — so
// they share one path here rather than five copies in the host. The host keeps attach and teardown.
// Each opens the conversation first. A send, a Stop and an option pick are conversation writes,
// admitted without the writer lease; the delivery loop starts the provider child a send needs, and
// an operation only the provider can perform starts it before admission.

import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../shared/agent-chat-permission-mode'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionPromptResult,
  AgentSessionSendResult
} from '../../../shared/agent-session-wire'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session-thread-goal-wire'
import type { AgentSessionPromptRequest } from './structured-agent-session-turns-prompt'
import { refuseThreadGoalUnsupported, threadGoalPlan } from './structured-agent-session-thread-goal'
import {
  mutateStructuredAgentSession,
  runStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import {
  openForProviderWrite,
  openForWrite,
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
import {
  runWithReadyStructuredAgentSessionOperation,
  openWithReadyStructuredAgentSessionChild,
  runAfterRewindStart
} from './structured-agent-session-ready-operation'
export type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import {
  readStructuredAgentSessionOptions,
  IN_PROCESS_OPTIONS_READER,
  type StructuredAgentSessionOptionsReader
} from './structured-agent-session-options-read'
import { writeStructuredAgentSessionOption } from './structured-agent-session-message-options'
import { settleStructuredAgentSessionLateDispatch } from './structured-agent-session-late-dispatch'

export function sendStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    body: AgentJournalMessageItem
    retryUnknown?: true
    delivery?: 'queue-if-active'
    /** Host-local: whether the sending client can manage an image card. */
    queuedImageCards?: boolean
    options?: Readonly<Record<string, string>>
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
  return runAfterRewindStart(context, caller.callerKey, params.envelope, plan, (selection) =>
    runStructuredAgentSessionMutation(
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
      sendPreparation(context, params.envelope, arrival, selection)
    )
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
    const { sessionId } = params.envelope
    return mutateStructuredAgentSession(
      context,
      caller,
      params.envelope,
      cancelPlan({
        ...params,
        childWork: () => context.readChildWork(sessionId),
        acknowledgeStops: (evidence) => context.publishChildWork(sessionId, evidence),
        captureStops: (targets) =>
          context.captureChildWorkStops(
            sessionId,
            targets.map((target) => target.providerId)
          ),
        // Untargeted, with work no record lists: the idle sweep's stop ends it with the agent.
        ...(params.taskId === undefined
          ? {
              unlisted: {
                present: () => context.childWorkIncomplete(sessionId),
                stop: () => context.stopAgent(sessionId, { cause: 'evict', resting: true })
              }
            }
          : {})
      }),
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
  const recordOnly = params.key === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
  const plan = setOptionPlan(params)
  const atRest = () => {
    const child = context.sessions.get(params.envelope.sessionId)?.child
    return recordOnly || !child || child.phase === 'starting' || child.close !== undefined
  }
  return runWithReadyStructuredAgentSessionOperation(
    context,
    caller.callerKey,
    params.envelope,
    plan,
    (selection) =>
      runStructuredAgentSessionMutation(
        context,
        caller,
        params.envelope,
        {
          ...plan,
          get conversationWrite() {
            return atRest() ? (true as const) : undefined
          },
          run: (ctx) => writeStructuredAgentSessionOption(context, ctx, params)
        },
        (ledger) =>
          atRest()
            ? openForWrite(context, params.envelope)()
            : openWithReadyStructuredAgentSessionChild(context, params.envelope, selection)(ledger)
      ),
    {
      needsAgent: () => {
        const child = context.sessions.get(params.envelope.sessionId)?.child
        return !recordOnly && Boolean(child && !child.close)
      },
      runAfterAgentEnds: true
    }
  )
}

export async function changeStructuredAgentSessionThreadGoal(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; change: AgentSessionThreadGoalChange }
): Promise<AgentSessionMutationResult<AgentSessionThreadGoalResult>> {
  const plan = threadGoalPlan(params)
  return runWithReadyStructuredAgentSessionOperation(
    context,
    caller.callerKey,
    params.envelope,
    plan,
    (selection) =>
      runStructuredAgentSessionMutation(
        context,
        caller,
        params.envelope,
        plan,
        openWithReadyStructuredAgentSessionChild(context, params.envelope, selection)
      ),
    {
      beforeAgent: (record) =>
        refuseThreadGoalUnsupported(context.deps.adapter, context.deps.agents, record?.provider)
    }
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
    // The RPC handler always names its client's reader; only in-process callers omit it.
    readOptions: (
      sessionId: string,
      reader: StructuredAgentSessionOptionsReader = IN_PROCESS_OPTIONS_READER
    ) => readStructuredAgentSessionOptions(context(), sessionId, reader),
    settleLateDispatch: (input: Parameters<typeof settleStructuredAgentSessionLateDispatch>[1]) =>
      settleStructuredAgentSessionLateDispatch(context(), input)
  }
}
