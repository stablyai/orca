// Everything a client can ask an ATTACHED session to do: send a turn, cancel one, answer a prompt,
// change an option, read the options back.
//
// They share one shape — admit the envelope against the lease, run a plan, publish the journal — so
// they share one path here rather than five copies in the host. The host keeps attach, holds and
// teardown. A send is the one mutation that may need those first: it makes sure the session has
// an owner as a step of its own serialized admission, see `structured-agent-session-send-preparation`.

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
import type { StructuredAgentSessionHolds } from './structured-agent-session-holds'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { threadGoalPlan } from './structured-agent-session-thread-goal'
import {
  admitAndRunAgentSessionMutation,
  type AgentSessionMutationRequest
} from './structured-agent-session-mutation-admission'
import {
  prepareStructuredAgentSessionSend,
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
  /** The session's child records, as the strip reads them; what command admission decides on. */
  readChildWork: (sessionId: string) => AgentChildWorkView[] | undefined
  requireSession: (sessionId: string) => StructuredAgentSessionHostSession
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  /** A send that finds the owner gone brings it back through here, inside its own serialize. */
  holds: Pick<StructuredAgentSessionHolds, 'ensureProviderChild'>
  /** Makes a closed session's journal readable again, inside the caller's serialize, for a send
   *  the ledger answers without an owner. */
  restoreReadable: (sessionId: string) => Promise<boolean>
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
      providerChildPhase: () => context.sessions.get(envelope.sessionId)?.providerChildPhase,
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
      run: (ctx) => {
        const blocked = structuredAgentSessionSendBlock(context.deps.store.getRecord(ctx.sessionId))
        return blocked ? Promise.resolve(blocked) : plan.run(ctx)
      }
    },
    (ledger, record) => prepareStructuredAgentSessionSend(context, params.envelope, ledger, record)
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
  return mutate(cancellationContext, caller, params.envelope, cancelPlan(params))
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
    const options = await context.deps.adapter.readOptions({ sessionId, fence: session.fence })
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
  } & ({ providerIdentity: AgentJournalItemIdentity } | { state: 'rejected'; reason: string })
): Promise<void> {
  const session = context.sessions.get(input.sessionId)
  if (!session) {
    return
  }
  // The journal queue drains before close; the host queue would defer this past teardown.
  await session.journal.resolveDispatch(
    'providerIdentity' in input
      ? {
          clientMessageId: input.clientMessageId,
          state: 'accepted',
          providerIdentity: input.providerIdentity,
          fence: session.fence
        }
      : {
          clientMessageId: input.clientMessageId,
          state: 'rejected',
          reason: input.reason,
          fence: session.fence
        }
  )
  context.publish(input.sessionId, session.journal)
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
  context: Pick<StructuredAgentSessionMutationContext, 'sessions' | 'publish'>,
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
      fence: session.fence,
      recovered: true
    })
  }
  context.publish(input.sessionId, session.journal)
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
