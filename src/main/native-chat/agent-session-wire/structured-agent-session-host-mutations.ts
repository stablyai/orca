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
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentSessionPromptRequest } from './structured-agent-session-turns-prompt'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { threadGoalPlan } from './structured-agent-session-thread-goal'
import {
  isMainAgentWorkingOnceFlushed,
  performCancel
} from './structured-agent-session-turns-cancel'
import {
  admitAndRunAgentSessionMutation,
  type AgentSessionMutationRequest,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import {
  openForWrite,
  openWithAgent,
  sendPreparation,
  structuredAgentSessionFailureWordsContext,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import { runQueueableStructuredAgentSessionSend } from './structured-agent-session-queued-send'
import { runStopWithQueuePause } from './structured-agent-session-queued-stop'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import {
  readStructuredAgentSessionOptions,
  recordStructuredAgentSessionOptionIntent
} from './structured-agent-session-options-read'

export type StructuredAgentSessionMutationContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  publish: (sessionId: string, journal: StructuredAgentSessionHostSession['journal']) => void
  flushStreamedEvents: (sessionId: string) => Promise<void>
  /** The host's accessor, for a caller outside the session's serialize. */
  conversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession>
  /** The session's child records, as the strip reads them; what command admission decides on. */
  readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The session's conversation, opened when closed; inside the caller's serialize. */
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** Gives the session a provider child; inside the caller's serialize. */
  ensureAgent: (sessionId: string) => Promise<AgentSessionMutationSessionPreparation>
  /** A message was accepted: the session's delivery loop hands it over. */
  wakeDelivery: (sessionId: string) => void
  /** Stops the session's provider child, keeping its conversation; inside the caller's serialize. */
  stopAgent: (sessionId: string) => Promise<void>
  /** Only for gate inputs living in the RECORD store, which can settle with no
   *  journal commit (a conversation command). Draft-table changes need no call:
   *  the draft store notifies through the journal's own commit listener. */
  wakeQueuedDrain?: (sessionId: string) => void
  now: () => number
}

/** Admits the envelope and runs the plan inside the session's serialize. */
export function mutateStructuredAgentSession<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  envelope: AgentSessionMutationEnvelope,
  plan: MutationPlan<TValue>,
  prepareSession?: AgentSessionMutationRequest<TValue>['prepareSession']
): Promise<AgentSessionMutationResult<TValue>> {
  return context.serialize(envelope.sessionId, () =>
    admitAndRunAgentSessionMutation({
      store: context.deps.store,
      adapter: context.deps.adapter,
      callerKey: caller.callerKey,
      envelope,
      plan,
      journal: () => context.sessions.get(envelope.sessionId)?.journal,
      prepareSession,
      publish: (journal) => context.publish(envelope.sessionId, journal),
      flushStreamedEvents: context.flushStreamedEvents,
      providerChildPhase: () => context.sessions.get(envelope.sessionId)?.child?.phase,
      now: () => context.now()
    })
  )
}

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
    sendPreparation(context, params.envelope)
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
  if (params.scope || params.prompt) {
    return mutateStructuredAgentSession(
      context,
      caller,
      params.envelope,
      cancelPlan({ ...params, childWork: () => context.readChildWork(params.envelope.sessionId) }),
      openForWrite(context, params.envelope)
    )
  }
  const plan = cancelPlan({
    ...params,
    stopChild: () => context.stopAgent(params.envelope.sessionId)
  })
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      // Stop's queue step, the same for every client: once the Stop takes effect
      // the queue is paused. The cards stay published; nothing is withdrawn and no
      // text ever rides the answer.
      run: (ctx) =>
        runStopWithQueuePause(ctx, async (tookEffect) => {
          // Stop withdraws every queued SUBMISSION first, whatever the start or the child is doing.
          const withdrawn = await ctx.journal.rejectQueuedSubmissions(
            ctx.fence,
            agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
          )
          const named = params.turnId !== undefined ? { turnId: params.turnId } : {}
          const child = context.sessions.get(ctx.sessionId)?.child
          if (child?.phase === 'starting') {
            // A start that may never land is the one thing here Stop has to end; the chat stays.
            await tookEffect()
            await context.stopAgent(ctx.sessionId)
            return { ok: true, value: { ...named, cancelled: true } }
          }
          // A Stop naming no turn ends nothing more unless the session reads working, by the rule
          // every session list and the chat's own Stop read it.
          const inFlight = params.turnId !== undefined || (await isMainAgentWorkingOnceFlushed(ctx))
          const record = context.deps.store.getRecord(ctx.sessionId)
          if (!child || !inFlight) {
            if (withdrawn.length > 0) {
              await tookEffect()
            }
            return { ok: true, value: { ...named, cancelled: withdrawn.length > 0 } }
          }
          await tookEffect()
          return performCancel(
            { ...ctx, failureTextContext: structuredAgentSessionFailureWordsContext(record) },
            {
              clientOperationId: params.envelope.clientOperationId,
              ...named,
              stopChild: () => context.stopAgent(params.envelope.sessionId),
              withdrewQueued: withdrawn.length > 0
            }
          )
        })
    },
    openForWrite(context, params.envelope)
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
    openForWrite(context, params.envelope)
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
    openForWrite(context, params.envelope)
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
