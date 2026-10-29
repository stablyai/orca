// Commit pending/settlement around an external provider call so concurrent sends remain acceptable.

import type { UnsentSendHold } from '../agent-session-journal/journal-unsent-send-hold'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { StructuredAgentSessionInputNotAdmitted } from './structured-agent-session-input-admission'
import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../shared/agent-session-failure'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import { isAbortSignalReason } from '../../../shared/abort-signal-reason'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { resolveHandover } from './structured-agent-session-operation-settlement'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import { agentJournalSubmissionKey } from '../../../shared/agent-session-journal-item-key'
import {
  handOverStructuredAgentSessionCommand,
  structuredAgentSessionHandoverOrigin
} from './structured-agent-session-command-turn'
import { carriedStoppedHistory } from './structured-agent-session-stopped-history-selection'
import { withStoppedHistory } from '../../../shared/agent-session-stopped-history'
import {
  markStructuredAgentSessionInputUnadmitted,
  beginStructuredAgentSessionHandover,
  whileStructuredAgentSessionHandingOver
} from './structured-agent-session-handing-over'

/** One input operation runs provider work outside ordering and commits its result inside it. */
export type StructuredAgentSessionPendingHandover = {
  run: (commit: (resolve: () => Promise<void>) => Promise<void>) => Promise<void>
}

/** Register abort before pending-row commit so Stop cannot fall between them.
 * Pending before dispatch makes crash delivery uncertain, never provably unwritten. */
export async function beginSubmissionHandover(
  ctx: AgentSessionHandoverContext,
  submission: AgentJournalSubmission,
  stillCurrent: () => boolean,
  isBound: () => boolean
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
  let carried = carriedStoppedHistory(ctx, turnScope, submission, body)
  let ownsChild = stillCurrent
  let closing: UnsentSendHold['cause'] | undefined
  let unwritten = false
  const release = ctx.deliveryOrder?.activateSend(ctx.sessionId, clientMessageId)
  // Pending rows precede the adapter’s held-send evidence.
  const released = beginStructuredAgentSessionHandover(
    ctx.journal,
    clientMessageId,
    ctx.workChanged,
    {
      close: (cause) => {
        closing = cause
      }
    }
  )
  const attempt = ctx.acquireAborts?.begin(ctx.sessionId, true, false, isBound)
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
    attempt?.end()
    release?.()
    released()
    throw error
  }
  const prepareFresh = async (fence: number): Promise<AgentJournalMessageItem> => {
    ctx.fence = fence
    carried = carriedStoppedHistory(ctx, AGENT_JOURNAL_THREAD_SCOPE, submission, body)
    await ctx.journal.resolveDispatch({
      clientMessageId,
      state: 'pending',
      fence,
      turnScope: AGENT_JOURNAL_THREAD_SCOPE,
      carries: carried?.covers ?? []
    })
    return carried ? withStoppedHistory(body, carried.messages) : body
  }
  // Preserve handover time so turn-open cannot re-anchor elapsed work.
  const requestedAt = structuredAgentSessionHandoverOrigin(ctx.journal, submission)
  return {
    run: async (commit) => {
      try {
        let outcome: AgentSessionDispatchOutcome | null
        try {
          for (;;) {
            try {
              markStructuredAgentSessionInputUnadmitted(
                ctx.journal,
                clientMessageId,
                released,
                false
              )
              unwritten = attempt?.signal.aborted === true
              outcome = unwritten
                ? cancelledDispatch(queued)
                : ownsChild()
                  ? await dispatchSafely(
                      ctx,
                      clientMessageId,
                      carried ? withStoppedHistory(body, carried.messages) : body,
                      requestedAt,
                      submission.options,
                      queued,
                      ownsChild,
                      prepareFresh,
                      attempt?.signal
                    )
                  : null
              break
            } catch (error) {
              if (!(error instanceof StructuredAgentSessionInputNotAdmitted)) {
                throw error
              }
              if (error.outcome) {
                unwritten = true
                outcome = error.outcome
                break
              }
              if (!ctx.continueInput) {
                throw error
              }
              markStructuredAgentSessionInputUnadmitted(
                ctx.journal,
                clientMessageId,
                released,
                true,
                attempt?.signal
              )
              const next = await ctx.continueInput(attempt?.signal, async (fence) => {
                await prepareFresh(fence)
              })
              if (next.kind === 'failed') {
                unwritten = true
                ctx.fence = next.fence
                outcome = next.outcome
                break
              }
              ownsChild = next.isCurrent
            }
          }
        } catch (error) {
          outcome = {
            state: 'unknown',
            reason: error instanceof Error ? error.message : String(error)
          }
        } finally {
          markStructuredAgentSessionInputUnadmitted(ctx.journal, clientMessageId, released, false)
          attempt?.end()
        }
        // Provider proof must precede the host tail that may be closing its child.
        if (outcome?.state !== 'unknown' && (!unwritten || !closing)) {
          await resolveHandover(ctx, clientMessageId, outcome)
        }
        await commit(async () => {
          if (outcome?.state === 'unknown') {
            await resolveHandover(
              { ...ctx, fence: ctx.record()?.lease.runtimeFence ?? ctx.fence },
              clientMessageId,
              outcome
            )
          }
          if (unwritten && closing) {
            await (closing && ctx.holdClosedInput
              ? ctx.holdClosedInput(clientMessageId, ctx.fence, closing)
              : resolveHandover(ctx, clientMessageId, outcome))
          }
          if (!outcome || outcome.state === 'admitted') {
            await ctx.settleEndedInput?.(released)
          }
          if (outcome?.state === 'accepted' || outcome?.state === 'admitted') {
            await ctx.recordRanOptions?.({
              message: submission.options,
              executed: outcome.ranOptions
            })
          }
        })
      } finally {
        release?.()
        released()
      }
    }
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
  isCurrent: () => boolean,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>,
  signal?: AbortSignal
): Promise<AgentSessionDispatchOutcome> {
  const { admitFreshInput } = ctx
  try {
    const outcome = await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body,
      ...(executionOptions ? { executionOptions } : {}),
      ...(signal ? { signal } : {}),
      ...(admitFreshInput
        ? { admitFreshInput: (enqueue) => admitFreshInput(enqueue, signal, prepare) }
        : {}),
      isCurrent,
      fence: ctx.fence,
      requestedAt,
      onInputPreparation: ctx.recordRanOptions?.prepareInput,
      onExecutionSnapshot: ctx.recordRanOptions?.checkpoint
    })
    return outcome
  } catch (error) {
    if (error instanceof StructuredAgentSessionInputNotAdmitted) {
      throw error
    }
    // This signal affects preparation only; its original reason proves no provider write.
    if (isAbortSignalReason(signal, error)) {
      throw new StructuredAgentSessionInputNotAdmitted(cancelledDispatch(queued))
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
function cancelledDispatch(
  neverReachedAgent: boolean
): Extract<AgentSessionDispatchOutcome, { state: 'rejected' }> {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(
      agentSessionFailureFact('cancelled', neverReachedAgent ? { neverReachedAgent } : {}),
      { surface: 'rejection' }
    )
  }
}
