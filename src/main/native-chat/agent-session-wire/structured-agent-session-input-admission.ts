import type { AgentSessionHandoverContext } from './structured-agent-session-host-types'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import { isAbortSignalReason } from '../../../shared/abort-signal-reason'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import { providerDiagnosticOf } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionDispatchOutcome } from './structured-agent-session-adapter'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentChatPermissionChoice } from '../../../shared/agent-chat-permission-mode'

export type StructuredAgentSessionInputAdmission =
  | { kind: 'prepare' }
  | { kind: 'acquire' }
  | { kind: 'sent'; response: Promise<unknown> }

/** The synchronous writer runs under host ordering; its response is awaited outside it. */
export type StructuredAgentSessionAdmitFreshInput = (
  enqueue: (
    mode: AgentChatPermissionChoice,
    inheritRunning: boolean,
    body?: AgentJournalMessageItem
  ) => StructuredAgentSessionInputAdmission,
  signal?: AbortSignal
) => Promise<StructuredAgentSessionInputAdmission>

export type StructuredAgentSessionAdmitHostInput = (
  enqueue: Parameters<StructuredAgentSessionAdmitFreshInput>[0],
  signal: AbortSignal | undefined,
  prepare: (fence: number) => Promise<AgentJournalMessageItem>
) => ReturnType<StructuredAgentSessionAdmitFreshInput>

export type StructuredAgentSessionContinueInput = (
  signal: AbortSignal | undefined,
  rebind: (fence: number) => Promise<void>
) => Promise<
  | { kind: 'ready'; isCurrent: () => boolean }
  | { kind: 'failed'; fence: number; outcome: AgentSessionDispatchOutcome }
>

/** Host-local control, never a provider failure or a replay of a possibly written request. */
export class StructuredAgentSessionInputNotAdmitted extends Error {
  constructor(readonly outcome?: Extract<AgentSessionDispatchOutcome, { state: 'rejected' }>) {
    super('input was not admitted')
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
