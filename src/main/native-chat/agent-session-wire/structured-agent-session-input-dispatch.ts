import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import { isAbortSignalReason } from '../../../shared/abort-signal-reason'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import {
  providerDiagnosticOf,
  agentSessionFailureFact
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  cancelledDispatch,
  StructuredAgentSessionInputNotAdmitted
} from './structured-agent-session-input-admission'

/** Adapter throws may be lost replies; never resend. Only explicit rejection proves non-delivery. */
export async function dispatchStructuredInputSafely(
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
          error.rejection ??
            agentSessionFailureFact('providerRejected', { detail: providerDiagnosticOf(error) }),
          { ...ctx.failureTextContext, surface: 'rejection' }
        )
      }
    }
    return { state: 'unknown', reason: error instanceof Error ? error.message : String(error) }
  }
}
