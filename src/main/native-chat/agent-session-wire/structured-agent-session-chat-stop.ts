// The chat's Stop, however a client reached it: the Stop button or a question card's Cancel. One
// body and one order: withdraw what is queued, record where the Stop took effect, interrupt, then
// end the child: in this step when the interrupt failed with the turn still running, else in the
// next step on the session's lane for a provider whose Stop ends its session. The body is
// reachable only through `mutateWithChatStop`, which queues that step in the same synchronous call
// as the mutation.

import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
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
  runRecordedStop,
  stopReachesUnrecordedWork,
  withdrawQueuedForStop
} from './structured-agent-session-queued-stop'
import {
  openForWrite,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import {
  endStoppedStructuredAgentSession,
  isMainAgentWorking,
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
  // The Stop's event, still landing when its session ends: the next step holds the lane for it.
  let eventAfterEnd: Promise<void> | undefined
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
        // Read before the withdrawal it decides on is issued.
        const hadQueued = ctx.journal.submissions().some(isQueuedAgentJournalSubmission)
        // Stop withdraws every queued SUBMISSION first, whatever the start or the child is doing.
        // Issued, not awaited: the interrupt never waits on bookkeeping. (The open paid any owed import.)
        const withdrew = withdrawQueuedForStop(ctx, () =>
          ctx.journal.rejectQueuedSubmissions(
            ctx.fence,
            agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' })
          )
        )
        const child = context.sessions.get(ctx.sessionId)?.child
        if (child?.close) {
          // A close an earlier stop began: this Stop joins it, retrying the exit's proof, rather
          // than asking a child that takes no input to stop again. Its event, issued ahead of that
          // retry, records only the withdrawal.
          const effect = hadQueued ? tookEffect() : Promise.resolve()
          await stopChild().catch((error: unknown) =>
            context.deps.logger.warn('ending the agent process on Stop failed', {
              scope: 'stop-child',
              sessionId,
              error
            })
          )
          await effect
          return { ok: true, value: { ...named, cancelled: await withdrew } }
        }
        if (child?.phase === 'starting') {
          // A start that may never land is the one thing here Stop has to end; the chat stays.
          // The event is issued first and lands behind the withdrawal, in the journal's queue order.
          const effect = tookEffect()
          try {
            await stopChild()
          } finally {
            // Even a failed Stop holds the lane until its event lands: the drain shares the lane.
            await effect
          }
          return { ok: true, value: { ...named, cancelled: true } }
        }
        // A Stop naming no turn ends nothing more unless the session reads working, by the rule
        // every session list and the chat's own Stop read it, over the fold as it stands.
        const inFlight = turnId !== undefined || isMainAgentWorking(ctx)
        const record = context.deps.store.getRecord(ctx.sessionId)
        if (!child || !inFlight) {
          // Nothing to interrupt, so the answer may wait for the withdrawal.
          const withdrewAny = await withdrew
          if (withdrewAny) {
            await tookEffect()
          }
          return { ok: true, value: { ...named, cancelled: withdrewAny } }
        }
        const reach = hadQueued ? 'unrecorded' : stopReachesUnrecordedWork(ctx, turnId)
        const priorStop = ctx.journal.stopMarks.latest()
        // Issued, not awaited, before the interrupt or any child end; the `finally` awaits it.
        const effect = reach === 'unrecorded' ? tookEffect() : Promise.resolve()
        // Its settle binds the latest Stop only when that Stop is this press's own, or the one in
        // force this press repeats; a late Stop or an event not yet written binds nothing. A write
        // is in the fold by its call's return, so a newer latest Stop is this press's event.
        const ownsLatestStop =
          reach === 'unrecorded'
            ? ctx.journal.stopMarks.latest()?.sequence !== priorStop?.sequence
            : reach === 'repeat'
        try {
          return await performCancel(
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
              withdrewQueued: withdrew,
              ...(ownsLatestStop ? { opensSettle: true as const } : {})
            }
          )
        } finally {
          // `effect` never rejects, so the Stop's own error survives. A session-ending Stop hands this
          // hold to its next step, so the child's end never waits on it.
          if (windDown) {
            eventAfterEnd = effect
          } else {
            await effect
          }
        }
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
    await eventAfterEnd
  })
  return result
}
