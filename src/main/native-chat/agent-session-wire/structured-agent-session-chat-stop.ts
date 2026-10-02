// The chat's Stop, however a client reached it: the Stop button or a question card's Cancel. One
// body and one order: withdraw what is queued, record where the Stop took effect, interrupt, then
// end the child: in this step when the interrupt failed with the turn still running, else in the
// next step on the session's lane for a provider whose Stop ends its session. The body is
// reachable only through `mutateWithChatStop`, which queues that step in the same synchronous call
// as the mutation.

import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
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
import { runRecordedStop, stopReachesUnrecordedWork } from './structured-agent-session-queued-stop'
import {
  openForWrite,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import {
  endStoppedStructuredAgentSession,
  isMainAgentWorkingOnceFlushed,
  performCancel,
  type StructuredAgentSessionStopWindDown
} from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

type ChatStopOutcome = TurnOutcome<AgentSessionCancelResult>

/** What the chat's Stop did, and whether its next step ends the provider's session. */
export type StructuredAgentSessionChatStopRun = { outcome: ChatStopOutcome; endsSession: boolean }

/** Runs `plan` with `run`, which may call `stop` for the chat's Stop. */
export function mutateWithChatStop<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; turnId?: string },
  plan: MutationPlan<TValue>,
  run: (
    ctx: AgentSessionTurnContext,
    stop: () => Promise<StructuredAgentSessionChatStopRun>
  ) => Promise<TurnOutcome<TValue>>
): Promise<AgentSessionMutationResult<TValue>> {
  const { envelope, turnId } = params
  const { sessionId } = envelope
  // Set by the Stop's step only when its provider's session ends; a replay leaves it unset.
  let windDown: StructuredAgentSessionStopWindDown | undefined
  const named = turnId !== undefined ? { turnId } : {}
  // Its own step wrote the Stop's event first.
  const stopChild = () => context.stopAgent(sessionId, { recorded: 'user-stop' })
  // The same for every client: once the Stop takes effect its event is written, and the queue's
  // pause follows from it. The cards stay published; no text rides the answer.
  const stop = (ctx: AgentSessionTurnContext): Promise<ChatStopOutcome> =>
    runRecordedStop(
      ctx,
      {
        reason: 'user-stop',
        caller: caller.callerKey,
        // A Stop that ends the provider's session ends whatever is in flight, so its event names
        // the live turn, or none (the turn opened next), never a named turn that already ended.
        ...(ctx.adapter.stopEndsSession?.(ctx.sessionId) === true ? {} : named)
      },
      async (tookEffect) => {
        // Stop withdraws every queued SUBMISSION first, whatever the start or the child is doing.
        const withdrawn = await ctx.journal.rejectQueuedSubmissions(
          ctx.fence,
          agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
        )
        const child = context.sessions.get(ctx.sessionId)?.child
        if (child?.phase === 'starting') {
          // A start that may never land is the one thing here Stop has to end; the chat stays.
          await tookEffect()
          await stopChild()
          return { ok: true, value: { ...named, cancelled: true } }
        }
        // A Stop naming no turn ends nothing more unless the session reads working, by the rule
        // every session list and the chat's own Stop read it.
        const inFlight = turnId !== undefined || (await isMainAgentWorkingOnceFlushed(ctx))
        const record = context.deps.store.getRecord(ctx.sessionId)
        if (!child || !inFlight) {
          if (withdrawn.length > 0) {
            await tookEffect()
          }
          return { ok: true, value: { ...named, cancelled: withdrawn.length > 0 } }
        }
        // Awaited until journal appends are synchronous; then issued here, and a `finally` awaits it.
        if (withdrawn.length > 0 || (await stopReachesUnrecordedWork(ctx, turnId))) {
          await tookEffect()
        }
        return performCancel(
          { ...ctx, failureTextContext: structuredAgentSessionFailureWordsContext(record) },
          {
            clientOperationId: envelope.clientOperationId,
            ...named,
            stopChild,
            onStopChildError: (error) =>
              context.deps.logger.warn('ending the agent process on Stop failed', {
                scope: 'stop-child',
                sessionId,
                error
              }),
            // The host drops its child only once the exit is proven, and nothing else runs meanwhile.
            childReleased: () => context.sessions.get(sessionId)?.child !== child,
            endSession: (owed) => {
              windDown = owed
            },
            withdrewQueued: withdrawn.length > 0
          }
        )
      }
    )
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
      await endStoppedStructuredAgentSession(
        { sessionId, adapter: context.deps.adapter },
        windDown,
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
