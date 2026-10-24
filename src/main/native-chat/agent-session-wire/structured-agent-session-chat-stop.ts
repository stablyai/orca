// Atomically accept Stop/withdrawals/receipt before acting on the captured target.
// Queue session-ending wind-down in the mutation’s tick; saved failures answer from the receipt.

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

export type StructuredAgentSessionChatStopRun = { outcome: ChatStopOutcome; endsSession: boolean }

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
  // Replayed Stops owe no second wind-down.
  let windDown:
    | { owed: StructuredAgentSessionStopWindDown; ctx: AgentSessionTurnContext }
    | undefined
  let reached = params.stoppedPrePrompt === true
  const named = turnId !== undefined ? { turnId } : {}
  const stopChild = () => context.stopAgent(sessionId, { recorded: 'user-stop' })
  const logChildEnd = (error: unknown) =>
    context.deps.logger.warn('ending the agent process on Stop failed', {
      scope: 'stop-child',
      sessionId,
      error
    })
  // Failed durable acceptance must leave the agent running.
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
  const act = async (
    ctx: AgentSessionTurnContext,
    target: ChatStopTarget,
    settled: boolean
  ): Promise<ChatStopOutcome> => {
    // Recheck target identity so newer children/turns remain untouched.
    const current = context.sessions.get(ctx.sessionId)?.child
    if (target.reach === 'withdraw' || !chatStopTargetStands(ctx, target, current)) {
      return { ok: true, value: { ...named, cancelled: settled } }
    }
    const { child } = target
    if (target.reach === 'close') {
      // Join existing close and retry exit proof; the child already refuses input.
      await stopChild().catch(logChildEnd)
      return { ok: true, value: { ...named, cancelled: settled } }
    }
    if (target.reach === 'starting') {
      // Unfinished starts cannot take interrupts; ending them settles handed-over work as unrun.
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
        // Host drops the child only after proven exit; no other work runs meanwhile.
        childReleased: () => context.sessions.get(sessionId)?.child !== child,
        endSession: (owed) => {
          windDown = { owed, ctx }
        },
        withdrewQueued: Promise.resolve(settled),
        noteFence: () => context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? ctx.fence,
        // Bind settlement to this event or the existing Stop it repeats.
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
    // Accepted Stop invalidates claims made even after its early abort.
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
      // Note post-commit failure on the most specific turn, then answer from the durable receipt.
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
  // Queue in the mutation’s tick so intervening sends wait behind child shutdown.
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
