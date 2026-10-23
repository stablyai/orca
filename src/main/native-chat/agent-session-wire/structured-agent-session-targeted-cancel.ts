// A Stop that writes no Stop event of its own: a background-task stop, and a prompt card's own
// interrupt. Its target is resolved once and its receipt committed before the provider is asked;
// one that reaches nothing records the no-op it answers. What the provider then says comes back
// as a note, never a refusal: a task still running, or a stop that could not be confirmed.

import { agentChildWorkStopTargets } from '../../../shared/agent-child-work-stop-targets'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionCancelResult } from '../../../shared/agent-session-wire'
import { validatePendingPrompt } from './structured-agent-session-prompt-state'
import { acceptStopTarget } from './structured-agent-session-stop-acceptance'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import {
  noteStructuredAgentSessionStopUnconfirmed,
  writeStructuredAgentSessionStopNote
} from './structured-agent-session-stop-unconfirmed-note'
import { isMainAgentWorking, performCancel } from './structured-agent-session-turns-cancel'
import {
  stopStructuredAgentSessionBackgroundWork,
  type StructuredAgentSessionBackgroundStopInput
} from './structured-agent-session-background-stop'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function runTargetedCancel(
  ctx: AgentSessionTurnContext,
  params: StructuredAgentSessionBackgroundStopInput & {
    clientOperationId: string
    turnId?: string
    scope?: 'background-tasks'
    prompt?: { itemId: string; expectedRevision: number }
  }
): Promise<TurnOutcome<AgentSessionCancelResult>> {
  const named = params.turnId !== undefined ? { turnId: params.turnId } : {}
  const { clientOperationId, prompt } = params
  if (params.scope) {
    // Resolved once, here: a retry is answered from the receipt and never reaches a newer task.
    const children = params.childWork?.()
    const targets = agentChildWorkStopTargets(children, params.taskId)
    const capturedStops = params.captureStops?.(targets)
    const unreadable = params.childWork !== undefined && children === undefined
    const initialUnlisted = params.unlisted?.present() ?? false
    if (targets.length === 0 && !unreadable && !(initialUnlisted && atRest(ctx))) {
      return { ok: true, value: { ...named, cancelled: false } }
    }
    const accepted = await acceptStopTarget(ctx)
    if (!accepted.ok) {
      return accepted
    }
    const cancelled = await stopCapturedBackgroundTasks(ctx, {
      operationId: clientOperationId,
      work: {
        targets,
        ...(capturedStops ? { targetCurrent: capturedStops.current } : {}),
        ...(unreadable ? { unreadable: true as const } : {}),
        acknowledgeStops: (evidence) => {
          capturedStops?.acknowledge(evidence)
          params.acknowledgeStops?.(evidence)
        },
        ...(initialUnlisted && params.unlisted ? { unlisted: { stop: params.unlisted.stop } } : {})
      },
      backgroundStop: params.taskId ? 'task' : 'all'
    })
    return { ok: true, value: { ...named, cancelled } }
  }
  // A card already settled is answered as it stands, changing nothing.
  const pending = prompt ? validatePendingPrompt(ctx, prompt) : undefined
  if (!pending || pending.ok) {
    const accepted = await acceptStopTarget(ctx)
    if (!accepted.ok) {
      return accepted
    }
  }
  try {
    return await performCancel(ctx, { clientOperationId, ...named, ...(prompt ? { prompt } : {}) })
  } catch (error) {
    if (ctx.operationReceipt?.isCommitted()) {
      // Saved, so the answer is its receipt; the card's turn says the cancellation went unconfirmed.
      const raised = pending?.ok ? pending.item.turnScope : undefined
      const raisedTurnId =
        raised?.kind === 'turn'
          ? (readAgentJournalTurn(ctx.journal.itemBody(raised.turnItemId) ?? undefined)?.turnId ??
            null)
          : null
      await noteStructuredAgentSessionStopUnconfirmed(
        ctx,
        { turnId: params.turnId ?? raisedTurnId, operationId: clientOperationId },
        error
      )
    }
    throw error
  }
}

/** A whole-agent Stop waits until the lead has no running turn. */
function atRest(ctx: AgentSessionTurnContext): boolean {
  return !isMainAgentWorking(ctx)
}

/** Stops the tasks the Stop captured. Tasks outlive the turn they began in, so its note is the
 *  thread's, keyed by this Stop's own id. */
async function stopCapturedBackgroundTasks(
  ctx: AgentSessionTurnContext,
  stop: {
    operationId: string
    work: Parameters<typeof stopStructuredAgentSessionBackgroundWork>[1]
    backgroundStop: 'task' | 'all'
  }
): Promise<boolean> {
  let result: { cancelled: boolean; stillRunning?: true }
  try {
    result = await stopStructuredAgentSessionBackgroundWork(ctx, stop.work, () => atRest(ctx))
  } catch (error) {
    // A timeout or lost contact proves nothing about the task: unconfirmed, never "not stopped".
    await noteStructuredAgentSessionStopUnconfirmed(
      ctx,
      { turnId: null, operationId: stop.operationId },
      error,
      AGENT_JOURNAL_THREAD_SCOPE
    )
    return false
  }
  if (result.stillRunning) {
    const words = agentSessionFailureWords(
      agentSessionFailureFact('backgroundTaskNotStopped', { backgroundStop: stop.backgroundStop }),
      { surface: 'row' }
    )
    await writeStructuredAgentSessionStopNote(
      ctx,
      stop.operationId,
      { kind: 'status', ...words },
      AGENT_JOURNAL_THREAD_SCOPE
    )
    return false
  }
  return result.cancelled
}
