import {
  structuredAgentSessionProviderRetryPending,
  retireStructuredAgentSessionProviderRetry,
  finishAbortedStructuredAgentSessionProviderRetry
} from './structured-agent-session-provider-retry'
// Atomically accept Stop/withdrawals/receipt before acting on the captured target.
// Queue session-ending wind-down in the mutation’s tick; saved failures answer from the receipt.

import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult
} from '../../../shared/agent-session-wire'
import {
  runStructuredAgentSessionMutation,
  type StructuredAgentSessionMutationContext
} from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from './structured-agent-session-host-types'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import {
  captureChatStopTarget,
  type ChatStopTarget
} from './structured-agent-session-chat-stop-target'
import {
  openForWrite,
  structuredAgentSessionFailureWordsContext
} from './structured-agent-session-send-preparation'
import { createChatStopAcceptor } from './structured-agent-session-stop-acceptance'
import {
  noteChatStopUnconfirmed,
  writeStructuredAgentSessionStopNote
} from './structured-agent-session-stop-unconfirmed-note'
import { STOP_NOTE_CANCELLATION_REQUESTED } from './structured-agent-session-turn-stop-notes'
import {
  endStoppedStructuredAgentSession,
  type StructuredAgentSessionChatStopWindDown
} from './structured-agent-session-stop-wind-down'
import { performCancel, type AcceptedChatStop } from './structured-agent-session-turns-cancel'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import type { AgentSessionCloseObserver } from './structured-agent-session-adapter-stop'
import {
  isStructuredAgentSessionCommandTurnId,
  structuredAgentSessionStopNoteIdentity,
  structuredAgentSessionCommandWasStopped
} from './structured-agent-session-command-turn'

type ChatStopOutcome = TurnOutcome<AgentSessionCancelResult>

export type StructuredAgentSessionChatStopRun = { outcome: ChatStopOutcome; endsSession: boolean }

export function mutateWithChatStop<TValue>(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: {
    envelope: AgentSessionMutationEnvelope
    turnId?: string
    stoppedPrePrompt?: boolean
    stoppedSend?: boolean
  },
  plan: MutationPlan<TValue>,
  run: (
    ctx: AgentSessionTurnContext,
    stop: () => Promise<StructuredAgentSessionChatStopRun>
  ) => Promise<TurnOutcome<TValue>>
): Promise<AgentSessionMutationResult<TValue>> {
  const { envelope, turnId } = params
  const { sessionId } = envelope
  // Replayed Stops owe no second wind-down.
  let windDown: StructuredAgentSessionChatStopWindDown | undefined
  let reached = params.stoppedPrePrompt === true
  const named = turnId !== undefined ? { turnId } : {}
  const logChildEnd = (error: unknown) =>
    context.deps.logger.warn('ending the agent process on Stop failed', {
      scope: 'stop-child',
      sessionId,
      operationId: envelope.clientOperationId,
      error
    })
  // Failed durable acceptance must leave the agent running.
  const accept = createChatStopAcceptor(caller, params)
  const act = async (
    ctx: AgentSessionTurnContext,
    target: ChatStopTarget,
    settled: boolean,
    acceptedStop: AcceptedChatStop
  ): Promise<ChatStopOutcome> => {
    // Turns may advance during acceptance; only a replacement child escapes this Stop.
    const current = context.sessions.get(ctx.sessionId)?.child
    if (target.reach === 'withdraw' || !target.child || current !== target.child) {
      return { ok: true, value: { ...named, cancelled: settled } }
    }
    const { child } = target
    const feedbackId = `child:${child.fence}:${child.generation ?? 'unknown'}`
    let stopOutcome = child.close?.stopOutcome
    const observeClose: AgentSessionCloseObserver = (evidence) => {
      if (stopOutcome && evidence) {
        stopOutcome.root = evidence.root === 'exited' ? 'exited' : stopOutcome.root
        stopOutcome.workload = evidence.workload === 'exited' ? 'exited' : stopOutcome.workload
        if (evidence.deathEvidenceKind) {
          stopOutcome.deathEvidenceKind = evidence.deathEvidenceKind
        }
      }
    }
    const stopChild = async () => {
      try {
        if (context.sessions.get(sessionId)?.child === child) {
          await context.stopAgent(sessionId, {
            recorded: 'user-stop',
            observeClose
          })
        }
      } finally {
        const observed = child.exitObservation?.().close
        observeClose({ ...observed?.processExit, deathEvidenceKind: observed?.deathEvidenceKind })
        if (child.close) {
          child.close.stopOutcome ??= stopOutcome
        }
      }
    }
    if (target.reach === 'close') {
      // Join existing close and retry exit proof; the child already refuses input.
      if (ctx.agent === 'codex') {
        stopOutcome ??= {
          pause: 'unconfirmed',
          interrupt: 'unconfirmed',
          root: 'unproven',
          workload: 'unproven',
          errors: []
        }
        windDown = {
          ctx,
          stopChild,
          owed: {
            outcome: stopOutcome,
            feedbackId,
            operationId: envelope.clientOperationId,
            noteFence: () =>
              context.deps.store.getRecord(sessionId)?.lease.runtimeFence ?? ctx.fence,
            waitsForProvider: false,
            stoppedAt: Date.now(),
            stopNote: structuredAgentSessionStopNoteIdentity(envelope.clientOperationId)
          }
        }
      } else {
        await stopChild().catch(logChildEnd)
      }
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
        acceptedStop,
        stopChild,
        onStopChildError: logChildEnd,
        // Host drops the child only after proven exit; no other work runs meanwhile.
        childReleased: () => context.sessions.get(sessionId)?.child !== child,
        endSession: (owed) => {
          stopOutcome = owed.outcome
          owed.feedbackId = feedbackId
          windDown = { owed, ctx, stopChild }
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
    const retrying = structuredAgentSessionProviderRetryPending(ctx.journal)
    const target = captureChatStopTarget(ctx, {
      child: context.sessions.get(ctx.sessionId)?.child ?? null,
      ...named,
      endsSession: true,
      stoppedPrePrompt: reached || operations.length > 0 || flight !== undefined,
      stoppedSend: params.stoppedSend
    })
    if (!target) {
      return { ok: true, value: { ...named, cancelled: false } }
    }
    const previouslyStopped =
      target.turnId !== null &&
      isStructuredAgentSessionCommandTurnId(target.turnId) &&
      structuredAgentSessionCommandWasStopped(ctx.journal, target.turnId)
    const accepted = await accept(ctx, target)
    if (!accepted.ok) {
      return accepted
    }
    retireStructuredAgentSessionProviderRetry(ctx.journal)
    for (const abort of operations) {
      abort()
      reached = true
    }
    // Accepted Stop invalidates claims made even after its early abort.
    if (flight && (target.queued || target.reach === 'withdraw' || target.reach === 'starting')) {
      flight.abort()
    }
    const noteTurnId = accepted.value.turnId ?? target.turnId
    const acceptedStop: AcceptedChatStop = {
      turnId: noteTurnId,
      turnScope: target.turnScope,
      previouslyStopped,
      ...((target.reach === 'interrupt' && (target.marks || target.turnId !== null)) ||
      accepted.value.settled
        ? {
            requestNoteWrite: writeStructuredAgentSessionStopNote(
              ctx,
              noteTurnId ?? envelope.clientOperationId,
              { kind: 'status', text: STOP_NOTE_CANCELLATION_REQUESTED },
              target.turnScope
            )
          }
        : {})
    }
    try {
      return await act(
        ctx,
        target,
        accepted.value.settled || reached || flight !== undefined || retrying,
        acceptedStop
      )
    } catch (error) {
      // Note post-commit failure on the most specific turn, then answer from the durable receipt.
      await noteChatStopUnconfirmed(
        ctx,
        target,
        accepted.value.turnId,
        envelope.clientOperationId,
        error
      )
      throw error
    }
  }
  const result = context.serialize(sessionId, async () => {
    try {
      return await runStructuredAgentSessionMutation(
        context,
        caller,
        envelope,
        {
          ...plan,
          run: (ctx) =>
            run(ctx, async () => ({
              outcome: await stop(ctx),
              endsSession: windDown !== undefined
            }))
        },
        openForWrite(context, envelope)
      )
    } finally {
      let shouldPublish = false
      try {
        const journal = context.sessions.get(sessionId)?.journal
        if (journal) {
          shouldPublish = true
          shouldPublish = finishAbortedStructuredAgentSessionProviderRetry(journal)
        }
      } catch (error) {
        context.deps.logger.warn('finishing an aborted retry after Stop failed', {
          scope: 'stop-retry-completion',
          sessionId,
          operationId: envelope.clientOperationId,
          error
        })
      }
      if (shouldPublish) {
        try {
          context.publishWorkChanged(sessionId)
        } catch (error) {
          context.deps.logger.warn('publishing retry completion after Stop failed', {
            scope: 'stop-retry-publication',
            sessionId,
            operationId: envelope.clientOperationId,
            error
          })
        }
      }
    }
  })
  // Queue in the mutation’s tick so intervening sends wait behind child shutdown.
  const shutdown = context.serialize(sessionId, async () => {
    if (windDown) {
      const { owed, ctx, stopChild } = windDown
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
  void shutdown.catch(logChildEnd)
  return result
}
