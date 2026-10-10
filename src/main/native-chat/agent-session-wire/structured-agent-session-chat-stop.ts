// The chat's Stop, however a client reached it: the Stop button or a question card's Cancel. One
// body and one order: decide what it acts on, accept it (its receipt, its Stop event and every
// queued send it settles, in one transaction), then, only while that target still stands, interrupt
// and end the child: in this step when the interrupt failed with the turn still running, else in
// the next step on the session's lane for a provider whose Stop ends its session. The body is
// reachable only through `mutateWithChatStop`, which queues that step in the same synchronous call
// as the mutation. A Stop reaching a start the lane is waiting on is admitted and saved outside the
// lane, aborts that start only once saved, and acts in the lane after it.

import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import { AGENT_SESSION_NOT_ATTACHED } from './structured-agent-session-mutation-refusals'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  captureChatStopTarget,
  chatStopTargetStands,
  type ChatStopTarget
} from './structured-agent-session-chat-stop-target'
import { structuredAgentSessionHostInstance } from './structured-agent-session-queued-pause'
import {
  openForWrite,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import { acceptChatStop, acceptStopTarget } from './structured-agent-session-stop-acceptance'
import {
  endStoppedStructuredAgentSession,
  type StructuredAgentSessionStopWindDown
} from './structured-agent-session-stop-wind-down'
import { performCancel } from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

type ChatStopOutcome = TurnOutcome<AgentSessionCancelResult>

/** What the chat's Stop did, and whether its next step ends the provider's session. */
export type StructuredAgentSessionChatStopRun = { outcome: ChatStopOutcome; endsSession: boolean }

/** Runs `plan` with `run`, which may call `stop` for the chat's Stop. `acquiring`: a Stop naming no
 *  turn, at a start the session's lane is waiting on, which it aborts once saved. */
export function mutateWithChatStop<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; turnId?: string; acquiring?: true },
  plan: MutationPlan<TValue>,
  run: (
    ctx: AgentSessionTurnContext,
    stop: () => Promise<StructuredAgentSessionChatStopRun>
  ) => Promise<TurnOutcome<TValue>>
): Promise<AgentSessionMutationResult<TValue>> {
  const { envelope, turnId, acquiring } = params
  const { sessionId } = envelope
  // Set by the Stop's step only when its provider's session ends; a replay leaves it unset.
  let windDown:
    | { owed: StructuredAgentSessionStopWindDown; ctx: AgentSessionTurnContext }
    | undefined
  const named = turnId !== undefined ? { turnId } : {}
  // Its own step wrote the Stop's event first.
  const stopChild = () => context.stopAgent(sessionId, { recorded: 'user-stop' })
  const logChildEnd = (error: unknown) =>
    context.deps.logger.warn('ending the agent process on Stop failed', {
      scope: 'stop-child',
      sessionId,
      error
    })
  const endSession = async (): Promise<void> => {
    if (windDown) {
      const { owed, ctx } = windDown
      await endStoppedStructuredAgentSession(
        { ...ctx, adapter: context.deps.adapter },
        owed,
        stopChild,
        (error) =>
          context.deps.logger.warn("ending a stopped chat's provider session failed", {
            scope: 'chat-stop',
            sessionId,
            error
          })
      )
    }
  }
  // Queued right behind the step that may set it, so a send made meanwhile lands behind the end.
  const endSessionAfter = () => void context.serialize(sessionId, endSession)
  // Accepted first, so a Stop that cannot be saved acts on nothing and the agent keeps running.
  const accept = async (
    ctx: AgentSessionTurnContext,
    target: ChatStopTarget
  ): Promise<TurnOutcome<{ settled: boolean }>> => {
    if (!target.marks) {
      const accepted = await acceptStopTarget(ctx)
      return accepted.ok ? { ok: true, value: { settled: false } } : accepted
    }
    const accepted = await acceptChatStop(ctx, {
      event: {
        reason: 'user-stop',
        caller: caller.callerKey,
        ...(target.eventTurnId !== null ? { turnId: target.eventTurnId } : {})
      },
      fence: ctx.fence,
      hostInstance: structuredAgentSessionHostInstance(),
      words: structuredAgentSessionFailureWordsContext(context.deps.store.getRecord(sessionId))
    })
    return accepted.ok
      ? { ok: true, value: { settled: accepted.value.settled.length > 0 } }
      : accepted
  }
  /** After the acceptance commits: only while what it captured still stands. */
  const act = async (
    ctx: AgentSessionTurnContext,
    target: ChatStopTarget,
    settled: boolean
  ): Promise<ChatStopOutcome> => {
    // Read again: what ran when it was accepted may have ended meanwhile, and a newer child or
    // turn is not this Stop's.
    const current = context.sessions.get(ctx.sessionId)?.child
    if (target.reach === 'starting' && !target.child) {
      // The start the lane waited on, aborted once the Stop was saved: it ended nothing more.
      return { ok: true, value: { ...named, cancelled: true } }
    }
    if (target.reach === 'hold' || !chatStopTargetStands(ctx, target, current)) {
      return { ok: true, value: { ...named, cancelled: settled } }
    }
    const { child } = target
    if (target.reach === 'close') {
      // A close an earlier stop began: this Stop joins it, retrying the exit's proof, rather than
      // asking a child that takes no input to stop again.
      await stopChild().catch(logChildEnd)
      return { ok: true, value: { ...named, cancelled: settled } }
    }
    if (target.reach === 'starting') {
      // A start that may never land takes no interrupt, so Stop ends it; the chat stays. Its end
      // withdraws what the child was handed first and holds the rest (`unrunRejection`).
      await stopChild()
      return { ok: true, value: { ...named, cancelled: true } }
    }
    const record = context.deps.store.getRecord(ctx.sessionId)
    return performCancel(
      { ...ctx, failureTextContext: structuredAgentSessionFailureWordsContext(record) },
      {
        clientOperationId: envelope.clientOperationId,
        ...named,
        stopChild,
        onStopChildError: logChildEnd,
        // The host drops its child only once the exit is proven, and nothing else runs meanwhile.
        childReleased: () => context.sessions.get(sessionId)?.child !== child,
        endSession: (owed) => {
          windDown = { owed, ctx }
        },
        withdrewQueued: Promise.resolve(settled),
        // This Stop's own event, or the one in force it repeats: its settle binds.
        opensSettle: true
      }
    )
  }
  const stop = async (ctx: AgentSessionTurnContext): Promise<ChatStopOutcome> => {
    const target = captureChatStopTarget(ctx, {
      child: context.sessions.get(ctx.sessionId)?.child ?? null,
      ...named,
      endsSession: ctx.adapter.stopEndsSession?.(ctx.sessionId) === true,
      ...(acquiring ? { acquiring } : {})
    })
    if (!target) {
      // Late, or nothing to stop: answered as a no-op, its receipt committed before the answer.
      return { ok: true, value: { ...named, cancelled: false } }
    }
    const accepted = await accept(ctx, target)
    if (!accepted.ok) {
      return accepted
    }
    const { settled } = accepted.value
    if (!acquiring) {
      return act(ctx, target, settled)
    }
    // Saved, so only now does the wait the lane is on stop. One that ended meanwhile landed what
    // this Stop was accepted against: acted on in the lane as it stands there.
    const aborted = context.acquireAborts.abort(sessionId, 'stopped while starting')
    const acted = context.serialize(sessionId, (): Promise<ChatStopOutcome> => {
      const fence = context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? ctx.fence
      const inLane = { ...ctx, fence }
      const landed = aborted
        ? target
        : captureChatStopTarget(inLane, {
            child: context.sessions.get(sessionId)?.child ?? null,
            endsSession: ctx.adapter.stopEndsSession?.(sessionId) === true
          })
      return landed
        ? act(inLane, landed, settled)
        : Promise.resolve({ ok: true, value: { cancelled: true } })
    })
    endSessionAfter()
    return acted
  }
  const result = mutateStructuredAgentSession(
    context,
    caller,
    envelope,
    {
      ...plan,
      run: (ctx) =>
        run(ctx, async () => ({ outcome: await stop(ctx), endsSession: windDown !== undefined }))
    },
    // Outside the lane only a conversation already open is written to.
    acquiring
      ? async () =>
          context.sessions.has(sessionId)
            ? { ok: true }
            : { ok: false, refusal: AGENT_SESSION_NOT_ATTACHED }
      : openForWrite(context, envelope),
    acquiring ? 'now' : 'queued'
  )
  if (!acquiring) {
    endSessionAfter()
  }
  return result
}
