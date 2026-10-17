// The chat's Stop, however a client reached it: the Stop button or a question card's Cancel. One
// body and one order: decide what it acts on, accept it (its receipt, its Stop event and every
// queued send it settles, in one transaction), then, only while that target still stands, interrupt
// and end the child: in this step when the interrupt failed with the turn still running, else in
// the next step on the session's lane for a provider whose Stop ends its session. The body is
// reachable only through `mutateWithChatStop`, which queues that step in the same synchronous call
// as the mutation. Once saved, a failure is answered from the Stop's receipt and noted on the chat.

import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  captureChatStopTarget,
  chatStopTargetStands,
  type ChatStopTarget
} from './structured-agent-session-chat-stop-target'
import {
  openForWrite,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import { acceptChatStop, acceptStopTarget } from './structured-agent-session-stop-acceptance'
import {
  noteStructuredAgentSessionStopUnconfirmed,
  writeStructuredAgentSessionStopNote
} from './structured-agent-session-stop-unconfirmed-note'
import { STOP_NOTE_CANCELLATION_REQUESTED } from './structured-agent-session-turn-stop-notes'
import {
  endStoppedStructuredAgentSession,
  type StructuredAgentSessionStopWindDown
} from './structured-agent-session-stop-wind-down'
import { performCancel } from './structured-agent-session-turns-cancel'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

type ChatStopOutcome = TurnOutcome<AgentSessionCancelResult>

/** What the chat's Stop did, and whether its next step ends the provider's session. */
export type StructuredAgentSessionChatStopRun = { outcome: ChatStopOutcome; endsSession: boolean }

/** Runs `plan` with `run`, which may call `stop` for the chat's Stop. */
export function mutateWithChatStop<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; turnId?: string; stoppedPrePrompt?: boolean },
  plan: MutationPlan<TValue>,
  run: (
    ctx: AgentSessionTurnContext,
    stop: () => Promise<StructuredAgentSessionChatStopRun>
  ) => Promise<TurnOutcome<TValue>>
): Promise<AgentSessionMutationResult<TValue>> {
  const { envelope, turnId } = params
  const { sessionId } = envelope
  // Set by the Stop's step only when its provider's session ends; a replay leaves it unset.
  let windDown:
    | { owed: StructuredAgentSessionStopWindDown; ctx: AgentSessionTurnContext }
    | undefined
  let reached = params.stoppedPrePrompt === true
  const named = turnId !== undefined ? { turnId } : {}
  // Its own step wrote the Stop's event first.
  const stopChild = () => context.stopAgent(sessionId, { recorded: 'user-stop' })
  const logChildEnd = (error: unknown) =>
    context.deps.logger.warn('ending the agent process on Stop failed', {
      scope: 'stop-child',
      sessionId,
      error
    })
  // Accepted first, so a Stop that cannot be saved acts on nothing and the agent keeps running.
  const accept = async (
    ctx: AgentSessionTurnContext,
    target: ChatStopTarget
  ): Promise<TurnOutcome<{ settled: boolean; turnId: string | null }>> => {
    if (!target.marks) {
      const accepted = await acceptStopTarget(ctx)
      return accepted.ok ? { ok: true, value: { settled: false, turnId: null } } : accepted
    }
    const accepted = await acceptChatStop(ctx, {
      event: {
        reason: 'user-stop',
        caller: caller.callerKey,
        ...(target.eventTurnId !== null ? { turnId: target.eventTurnId } : {})
      },
      fence: ctx.fence
    })
    return accepted.ok
      ? {
          ok: true,
          value: {
            settled: target.queued || reached,
            turnId: accepted.value.turnId
          }
        }
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
    if (target.reach === 'withdraw' || !chatStopTargetStands(ctx, target, current)) {
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
      // settles what the child was handed as stopped (`unrunRejection`).
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
        noteFence: () => context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? ctx.fence,
        // This Stop's own event, or the one in force it repeats: its settle binds.
        opensSettle: true
      }
    )
  }
  const stop = async (ctx: AgentSessionTurnContext): Promise<ChatStopOutcome> => {
    const operations = context.acquireAborts.captureOperations(sessionId)
    const flight = context.startFlights.get(sessionId)
    const target = captureChatStopTarget(ctx, {
      child: context.sessions.get(ctx.sessionId)?.child ?? null,
      ...named,
      endsSession: ctx.adapter.stopEndsSession?.(ctx.sessionId) === true,
      stoppedPrePrompt: reached || operations.length > 0 || flight !== undefined
    })
    if (!target) {
      // Late, or nothing to stop: answered as a no-op, its receipt committed before the answer.
      return { ok: true, value: { ...named, cancelled: false } }
    }
    const accepted = await accept(ctx, target)
    if (!accepted.ok) {
      return accepted
    }
    for (const abort of operations) {
      abort()
      reached = true
    }
    // Invalidation belongs to the accepted Stop, including a claim made after its early abort.
    if (flight && (target.queued || target.reach === 'withdraw' || target.reach === 'starting')) {
      flight.abort()
    }
    if (reached && target.reach === 'withdraw') {
      await writeStructuredAgentSessionStopNote(
        ctx,
        accepted.value.turnId ?? envelope.clientOperationId,
        { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED },
        contextStructuredAgentSessionCurrentWork(ctx).turnScope()
      )
    }
    try {
      return await act(ctx, target, accepted.value.settled || reached || flight !== undefined)
    } catch (error) {
      // Saved, then failed: noted on the chat, then thrown so the answer is the Stop's receipt.
      // On the turn its event named, else the one it named, else the one live now.
      const stoppedTurnId =
        accepted.value.turnId ??
        (target.named
          ? target.turnId
          : contextStructuredAgentSessionCurrentWork(ctx).activeTurnId())
      await noteStructuredAgentSessionStopUnconfirmed(
        ctx,
        { turnId: stoppedTurnId, operationId: envelope.clientOperationId },
        error
      )
      throw error
    }
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
    openForWrite(context, envelope)
  )
  // Queued in the mutation's own tick, so a send made meanwhile lands behind the child's end.
  void context.serialize(sessionId, async () => {
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
  })
  return result
}
