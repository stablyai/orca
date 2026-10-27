// Targeted Stops commit a fixed target/result before effects, without a whole-agent Stop event.
// Provider uncertainty becomes a note; retries answer the receipt without retargeting.

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
      // Acceptance is durable; report uncertainty on the captured prompt’s turn.
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

function atRest(ctx: AgentSessionTurnContext): boolean {
  return !isMainAgentWorking(ctx)
}

/** Tasks outlive their opening turn, so feedback is thread-scoped and keyed by Stop operation. */
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
    // Lost contact proves nothing; report unconfirmed, never “not stopped”.
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
