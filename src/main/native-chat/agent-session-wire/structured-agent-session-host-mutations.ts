// Everything a client can ask an ATTACHED session to do: send a turn, cancel one, answer a prompt,
// change an option, read the options back.
//
// They share one shape — admit the envelope against the lease, run a plan, publish the journal — so
// they share one path here rather than five copies in the host. The host keeps attach, holds and
// teardown. A send and a Stop are conversation writes: they open the conversation and are admitted
// without the writer lease; the session's delivery loop starts the provider child a send needs.

import type {
  AgentJournalItemIdentity,
  AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult,
  AgentSessionPromptResult,
  AgentSessionSendResult,
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session-wire'
import {
  DISPATCH_REJECTION_CANCELLED,
  type AgentJournalDispatchRejection
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { threadGoalPlan } from './structured-agent-session-thread-goal'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import {
  admitAndRunAgentSessionMutation,
  type AgentSessionMutationRequest
} from './structured-agent-session-mutation-admission'
import {
  openConversationForWrite,
  structuredAgentSessionSendBlock
} from './structured-agent-session-send-preparation'
import {
  cancelPlan,
  promptPlan,
  sendPlan,
  setOptionPlan,
  type MutationPlan
} from './structured-agent-session-mutation-plans'
import type {
  StructuredAgentSessionCaller,
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type StructuredAgentSessionMutationContext = {
  deps: StructuredAgentSessionHostDeps
  sessions: Map<string, StructuredAgentSessionHostSession>
  publish: (sessionId: string, journal: StructuredAgentSessionHostSession['journal']) => void
  flushStreamedEvents: (sessionId: string) => Promise<void>
  requireSession: (sessionId: string) => StructuredAgentSessionHostSession
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** The session's conversation, opened when closed; inside the caller's serialize. */
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  /** A message was accepted: the session's delivery loop hands it over. */
  wakeDelivery: (sessionId: string) => void
  /** Stops the session's provider child, keeping its conversation; inside the caller's serialize. */
  stopAgent: (sessionId: string) => Promise<void>
  now: () => number
}

function mutate<TValue>(
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
    beforeRun?: () => void
  }
): Promise<AgentSessionMutationResult<AgentSessionSendResult>> {
  const plan = sendPlan(params)
  return mutate(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      run: async (ctx) => {
        const blocked = structuredAgentSessionSendBlock(context.deps.store.getRecord(ctx.sessionId))
        if (blocked) {
          return blocked
        }
        const accepted = await plan.run(ctx)
        if (accepted.ok) {
          context.wakeDelivery(ctx.sessionId)
        }
        return accepted
      }
    },
    () => openConversationForWrite(context.openConversation, params.envelope)
  )
}

export function cancelStructuredAgentSessionTurn(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    turnId: string
    scope?: 'background-tasks'
    taskId?: string
    prompt?: { itemId: string; expectedRevision: number }
  }
): Promise<AgentSessionMutationResult<AgentSessionCancelResult>> {
  const command = context.deps.store.getRecord(params.envelope.sessionId)?.conversationCommand
  // Interrupts must reach a provider while the command awaits its terminal frame.
  const cancellationContext =
    command?.command === 'compact' && command.phase === 'prepared'
      ? {
          ...context,
          serialize: <T>(sessionId: string, task: () => Promise<T>) =>
            context.serialize(`compact-cancel:${sessionId}`, task)
        }
      : context
  const plan = cancelPlan(params)
  if (params.scope || params.prompt) {
    return mutate(cancellationContext, caller, params.envelope, plan)
  }
  return mutate(
    cancellationContext,
    caller,
    params.envelope,
    {
      ...plan,
      run: async (ctx) => {
        // Stop withdraws every queued message first, whatever the start or the child is doing.
        const withdrawn = await ctx.journal.rejectQueuedSubmissions(
          ctx.fence,
          DISPATCH_REJECTION_CANCELLED
        )
        const child = context.sessions.get(ctx.sessionId)?.child
        if (child?.phase === 'starting') {
          // A start that may never land is the one thing here Stop has to end; the chat stays.
          await context.stopAgent(ctx.sessionId)
          return { ok: true, value: { turnId: params.turnId, cancelled: true } }
        }
        return child
          ? plan.run(ctx)
          : { ok: true, value: { turnId: params.turnId, cancelled: withdrawn.length > 0 } }
      }
    },
    () => openConversationForWrite(context.openConversation, params.envelope)
  )
}

export function respondToStructuredAgentSessionPrompt(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    kind: 'approval' | 'question'
    itemId: string
    expectedRevision: number
    optionId: string
  }
): Promise<AgentSessionMutationResult<AgentSessionPromptResult>> {
  return mutate(context, caller, params.envelope, promptPlan(params))
}

export async function setStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; key: string; value: string }
): Promise<AgentSessionMutationResult<AgentSessionOptionResult>> {
  // Outside the queue: a pick made while the provider starts then queues behind what its start persists.
  await context.deps.adapter.awaitOptionWritable?.(params.envelope.sessionId)
  return mutate(context, caller, params.envelope, setOptionPlan(params))
}

export function changeStructuredAgentSessionThreadGoal(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; change: AgentSessionThreadGoalChange }
): Promise<AgentSessionMutationResult<AgentSessionThreadGoalResult>> {
  return mutate(context, caller, params.envelope, threadGoalPlan(params))
}

export function readStructuredAgentSessionOptions(
  context: StructuredAgentSessionMutationContext,
  sessionId: string
): Promise<AgentSessionOptionsResult> {
  return context.serialize(sessionId, async () => {
    const session = context.requireSession(sessionId)
    if (!context.deps.adapter.readOptions) {
      throw new Error('structured_agent_session_options_unsupported')
    }
    const options = await context.deps.adapter.readOptions({
      sessionId,
      fence:
        session.child?.fence ??
        structuredAgentSessionConversationFence(context.deps.store, sessionId)
    })
    return {
      ...options,
      rewind:
        context.deps.store.getRecord(sessionId)?.rewind?.phase === 'prepared' ||
        context.deps.store.getRecord(sessionId)?.rewind?.phase === 'provider-succeeded'
          ? { supported: false, reason: 'outcome-unknown' }
          : (context.deps.adapter.rewindSupport?.(sessionId) ?? {
              supported: false,
              reason: 'unsupported'
            }),
      conversationCommands: context.deps.adapter.compact ? ['clear', 'compact'] : ['clear'],
      ...(context.deps.adapter.supportsThreadGoal?.(sessionId)
        ? { threadGoal: { current: session.journal.threadGoal() } }
        : {}),
      ...(context.deps.adapter.recordsContextUsage?.(sessionId)
        ? { contextUsage: { current: session.journal.contextUsage() } }
        : {})
    }
  })
}

/** Settle provider-proven delivery independently of an in-flight client mutation. */
export async function settleStructuredAgentSessionLateDispatch(
  context: StructuredAgentSessionMutationContext,
  input: {
    sessionId: string
    clientMessageId: string
  } & (
    | { providerIdentity: AgentJournalItemIdentity }
    | ({ state: 'rejected' } & AgentJournalDispatchRejection)
  )
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const fence = structuredAgentSessionConversationFence(context.deps.store, input.sessionId)
  // The journal queue drains before close; the host queue would defer this past teardown.
  await session.journal.resolveDispatch(
    'providerIdentity' in input
      ? {
          clientMessageId: input.clientMessageId,
          state: 'accepted',
          providerIdentity: input.providerIdentity,
          fence
        }
      : {
          clientMessageId: input.clientMessageId,
          state: 'rejected',
          reason: input.reason,
          rejection: input.rejection,
          fence
        }
  )
}

/**
 * Releases sends the provider can no longer be holding.
 *
 * A dispatch whose RPC timed out is recorded `unknown` — doubt, never proof of
 * non-delivery — and a live `unknown` reads as work still owed, so the session
 * shows working until something re-derives it. The provider reporting its thread
 * not running, with no turn open, IS that re-derivation.
 *
 * `pending` is deliberately untouched: that send's dispatch has not returned yet
 * and may be in flight right now. And `recovered` only retires the obligation —
 * it never makes a send re-deliverable, because the provider may well have run it.
 */
export async function releaseStructuredAgentSessionUnansweredDispatches(
  context: Pick<StructuredAgentSessionMutationContext, 'sessions'> & {
    deps: { store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'> }
  },
  input: { sessionId: string; reason: string }
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  const stranded = session.journal
    .submissions()
    .filter((entry) => entry.dispatchState === 'unknown' && entry.recovered !== true)
  if (stranded.length === 0) {
    return
  }
  for (const entry of stranded) {
    await session.journal.resolveDispatch({
      clientMessageId: entry.clientMessageId,
      state: 'unknown',
      // The earlier reason names a sharper fact than this one does.
      reason: entry.reason ?? input.reason,
      fence: structuredAgentSessionConversationFence(context.deps.store, input.sessionId),
      recovered: true
    })
  }
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
