// Everything a client can ask a session to do: send a turn, cancel one, answer a prompt, change an
// option, read the options back.
//
// They share one shape — admit the envelope against the lease, run a plan, publish the journal — so
// they share one path here rather than five copies in the host. The host keeps attach and teardown.
// Each opens the conversation first. A send, a Stop and an option pick are conversation writes,
// admitted without the writer lease; the delivery loop starts the provider child a send needs, and
// an operation only the provider can perform starts it before admission.

import { latestNativeChatUsageLimitCut } from '../../../shared/native-chat-usage-limit-cut'
import { refuse } from '../../../shared/agent-session-wire'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { shouldQueueStructuredAgentSessionSend } from './structured-agent-session-queued-messages'
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
  recordStructuredAgentSessionOptionIntent,
  type StructuredAgentSessionOptionsReader
} from './structured-agent-session-options-read'
import { settleStructuredAgentSessionLateDispatch } from './structured-agent-session-late-dispatch'
import { releaseStructuredAgentSessionUnansweredDispatches } from './structured-agent-session-unanswered-dispatch-release'

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
    usageLimitContinuationOfTurnItemId?: string
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
        run: async (ctx) => {
          const record = context.deps.store.getRecord(ctx.sessionId)
          const blocked = structuredAgentSessionSendBlock(record)
          if (blocked) {
            return blocked
          }
          if (params.usageLimitContinuationOfTurnItemId !== undefined) {
            const snapshot = ctx.journal.snapshot()
            const cut = latestNativeChatUsageLimitCut(snapshot.items, snapshot.submissions)
            if (
              cut?.turnItemId !== params.usageLimitContinuationOfTurnItemId ||
              shouldQueueStructuredAgentSessionSend({
                record,
                journal: ctx.journal,
                work: contextStructuredAgentSessionCurrentWork(ctx)
              })
            ) {
              return {
                ok: false as const,
                refusal: refuse(
                  'agent_session_operation_invalid',
                  { reason: 'continuationSuperseded' },
                  'This chat has moved on. Check the latest messages before continuing.'
                )
              }
            }
          }
          return runQueueableStructuredAgentSessionSend(context, ctx, params, () => plan.run(ctx))
        }
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
  const stoppedPrePrompt =
    !prompt && params.turnId === undefined
      ? abortProviderWaitForStop(context, caller, params.envelope, plan)
      : false
  // A card's Cancel stops whatever the chat has in flight, as the Stop button does; it reaches the
  // Stop only for a card the live turn raised (`cancelStructuredAgentSessionPrompt`).
  const stopped = prompt ? { envelope: params.envelope } : { ...params, stoppedPrePrompt }
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
function abortProviderWaitForStop(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<AgentSessionCancelResult>
): boolean {
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
    return false
  }
  return context.acquireAborts.abort(envelope.sessionId, 'stopped while starting')
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
  const plan = setOptionPlan(params)
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      conversationWrite: true,
      run: (ctx) => recordStructuredAgentSessionOptionIntent(context.deps, ctx, params)
    },
    openForWrite(context, params.envelope)
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
        threadGoalPlan({ ...params, signal: selection.signal }),
        openWithReadyStructuredAgentSessionChild(context, params.envelope, selection)
      ),
    {
      goal: true,
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
      settleStructuredAgentSessionLateDispatch(context(), input),
    releaseUnansweredDispatches: (
      input: Parameters<typeof releaseStructuredAgentSessionUnansweredDispatches>[1]
    ) => releaseStructuredAgentSessionUnansweredDispatches(context(), input)
  }
}
