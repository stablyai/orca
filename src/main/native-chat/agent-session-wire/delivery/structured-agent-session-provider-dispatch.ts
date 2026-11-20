import type { AgentSessionHandoverContext } from '../host/structured-agent-session-host-types'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionExecutionOptions } from '../../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { AgentSessionDispatchOutcome } from '../providers/structured-agent-session-adapter'
import { StructuredAgentSessionInputNotAdmitted } from './structured-agent-session-input-admission'
import { isAbortSignalReason } from '../../../../shared/concurrency/abort-signal-reason'
import { isAgentSessionOptionRejectedError } from '../options/structured-agent-session-option-error'
import {
  agentSessionFailureFact,
  providerDiagnosticOf
} from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import { AgentImageFitError } from '../../agent-images/agent-image-fit-client'

/** Adapter throws may be lost replies; never resend. Only explicit rejection proves non-delivery. */
export async function dispatchSafely(
  ctx: AgentSessionHandoverContext,
  clientMessageId: string,
  body: AgentJournalMessageItem,
  requestedAt: number,
  executionOptions: AgentSessionExecutionOptions | undefined,
  queued: boolean,
  isCurrent: () => boolean,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>,
  fitImages: (
    body: AgentJournalMessageItem,
    signal?: AbortSignal
  ) => Promise<AgentJournalMessageItem>,
  signal?: AbortSignal
): Promise<AgentSessionDispatchOutcome> {
  const { admitFreshInput } = ctx
  try {
    return await ctx.adapter.dispatch({
      sessionId: ctx.sessionId,
      clientMessageId,
      body: await fitImages(body, signal),
      ...(executionOptions ? { executionOptions } : {}),
      ...(signal ? { signal } : {}),
      ...(admitFreshInput
        ? {
            admitFreshInput: (enqueue, _signal, kind) =>
              admitFreshInput(enqueue, signal, prepare, kind, fitImages)
          }
        : {}),
      isCurrent,
      fence: ctx.fence,
      requestedAt,
      onInputPreparation: ctx.recordRanOptions?.prepareInput,
      onExecutionSnapshot: ctx.recordRanOptions?.checkpoint
    })
  } catch (error) {
    if (error instanceof StructuredAgentSessionInputNotAdmitted) {
      throw error
    }
    // This signal affects preparation only; its original reason proves no provider write.
    if (isAbortSignalReason(signal, error)) {
      throw new StructuredAgentSessionInputNotAdmitted(cancelledDispatch(queued))
    }
    if (error instanceof AgentImageFitError) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          agentSessionFailureFact('attachmentUnreadable', { neverReachedAgent: true }),
          {
            ...ctx.failureTextContext,
            surface: 'rejection'
          }
        )
      }
    }
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        state: 'rejected',
        ...agentSessionFailureWords(
          error.rejection ??
            agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
          { ...ctx.failureTextContext, surface: 'rejection' }
        )
      }
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Non-delivery proof applies only to queued handoffs; direct sends still owe stopped-history handling. */
export function cancelledDispatch(
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
