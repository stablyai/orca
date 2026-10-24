// Commit pending/settlement around an external provider call so concurrent sends remain acceptable.

import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type { StructuredAgentSessionRanRecorder } from './structured-agent-session-ran-options'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { isAbortSignalReason } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { DISPATCH_DOUBT_PERSISTENCE_FAILED } from '../agent-session-journal/journal-dispatch-doubt-reasons'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  handOverStructuredAgentSessionCommand,
  structuredAgentSessionHandoverOrigin,
  type StructuredAgentSessionCommandHandoverContext
} from './structured-agent-session-command-turn'
import type { StructuredAgentSessionDeliveryOrder } from './structured-agent-session-delivery-order'
import { carriedStoppedHistory } from './structured-agent-session-stopped-history-selection'
import { withStoppedHistory } from '../../../shared/agent-session-stopped-history'
import {
  beginStructuredAgentSessionHandover,
  whileStructuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

export type AgentSessionHandoverContext = StructuredAgentSessionCommandHandoverContext & {
  acquireAborts?: Pick<StructuredAgentSessionAcquireAborts, 'begin'>
  deliveryOrder?: StructuredAgentSessionDeliveryOrder
  workChanged?: () => void
  /** Retain executed options only when the chat has no saved choice. */
  recordRanOptions?: ReturnType<StructuredAgentSessionRanRecorder>
}

export type StructuredAgentSessionPendingHandover = {
  dispatch: () => Promise<() => Promise<void>>
  release?: () => void
}

/** Register abort before pending-row commit so Stop cannot fall between them.
 * Pending before dispatch makes crash delivery uncertain, never provably unwritten. */
export async function beginSubmissionHandover(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission,
  stillCurrent: () => boolean
): Promise<StructuredAgentSessionPendingHandover | null> {
  const { clientMessageId } = submission
  const body = ctx.journal.itemBody(agentJournalSubmissionKey(clientMessageId))
  if (body?.kind !== 'message') {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('hostFault'), { surface: 'rejection' }),
      fence: ctx.fence
    })
    return null
  }
  if (body.command) {
    await whileStructuredAgentSessionHandingOver(
      ctx.journal,
      clientMessageId,
      async () => handOverStructuredAgentSessionCommand(ctx, submission, body),
      ctx.workChanged
    )
    return null
  }
  // Join only current turns; persist stopped-history carry before writing to the provider.
  const turnScope = contextStructuredAgentSessionCurrentWork(ctx).turnScope()
  const carried = carriedStoppedHistory(ctx, turnScope, submission, body)
  const release = ctx.deliveryOrder?.activateSend(ctx.sessionId, clientMessageId)
  // Pending rows precede the adapter’s held-send evidence.
  const released = beginStructuredAgentSessionHandover(
    ctx.journal,
    clientMessageId,
    ctx.workChanged
  )
  const attempt = ctx.acquireAborts?.begin(ctx.sessionId, true)
  const queued = submission.queuedMessageId !== undefined
  try {
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence: ctx.fence,
      turnScope,
      ...(carried ? { carries: carried.covers } : {})
    })
  } catch (error) {
    released()
    release?.()
    attempt?.end()
    throw error
  }
  // Preserve handover time so turn-open cannot re-anchor elapsed work.
  const requestedAt = structuredAgentSessionHandoverOrigin(ctx.journal, submission)
  return {
    release: () => {
      released()
      release?.()
    },
    dispatch: async () => {
      let outcome: AgentSessionDispatchOutcome | null
      try {
        // Pre-call abort proves queued cards never reached the provider.
        outcome = attempt?.signal.aborted
          ? cancelledDispatch(queued)
          : // Ended-child settlement owns the row; never write to a replaced child.
            stillCurrent()
            ? await dispatchSafely(
                ctx,
                clientMessageId,
                carried ? withStoppedHistory(body, carried.messages) : body,
                requestedAt,
                submission.options,
                queued,
                attempt?.signal
              )
            : null
      } finally {
        attempt?.end()
      }
      return async () => {
        await resolveHandover(ctx, clientMessageId, outcome)
        if (outcome?.state === 'accepted' || outcome?.state === 'admitted') {
          await ctx.recordRanOptions?.({
            message: submission.options,
            executed: outcome.ranOptions
          })
        }
      }
    }
  }
}

async function resolveHandover(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  outcome: AgentSessionDispatchOutcome | null
): Promise<void> {
  if (!outcome || outcome.state === 'admitted') {
    return
  }
  try {
    await ctx.journal.resolveDispatch(
      outcome.state === 'accepted'
        ? {
            clientMessageId,
            state: 'accepted',
            providerIdentity: outcome.providerIdentity,
            fence: ctx.fence
          }
        : outcome.state === 'rejected'
          ? {
              clientMessageId,
              state: 'rejected',
              reason: outcome.reason,
              rejection: outcome.rejection,
              ...(outcome.answeredInTurn ? { answeredInTurn: outcome.answeredInTurn } : {}),
              fence: ctx.fence
            }
          : { clientMessageId, state: 'unknown', reason: outcome.reason, fence: ctx.fence }
    )
  } catch (error) {
    // Persist uncertainty if settlement fails; next-open recovery handles any remaining pending row.
    try {
      await ctx.journal.resolveDispatch({
        clientMessageId,
        state: 'unknown',
        reason: DISPATCH_DOUBT_PERSISTENCE_FAILED,
        fence: ctx.fence
      })
    } catch {}
    throw error
  }
}

/** Adapter throws may be lost replies; never resend. Only explicit rejection proves non-delivery. */
async function dispatchSafely(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  requestedAt: number,
  executionOptions: AgentSessionExecutionOptions | undefined,
  queued: boolean,
  signal?: AbortSignal
): Promise<AgentSessionDispatchOutcome> {
  try {
    const outcome = await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      ...(executionOptions ? { executionOptions } : {}),
      ...(signal ? { signal } : {}),
      fence: ctx.fence,
      requestedAt,
      onInputPreparation: ctx.recordRanOptions?.prepareInput,
      onExecutionSnapshot: ctx.recordRanOptions?.checkpoint
    })
    return outcome
  } catch (error) {
    // This signal affects preparation only; its original reason proves no provider write.
    if (isAbortSignalReason(signal, error)) {
      return cancelledDispatch(queued)
    }
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
          { surface: 'rejection' }
        )
      }
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Non-delivery proof applies only to queued handoffs; direct sends still owe stopped-history handling. */
function cancelledDispatch(neverReachedAgent: boolean): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('cancelled', neverReachedAgent ? { neverReachedAgent } : {}),
      { surface: 'rejection' }
    )
  }
}
