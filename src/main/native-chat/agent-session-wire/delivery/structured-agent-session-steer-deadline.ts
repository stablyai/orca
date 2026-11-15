import { waitForPromiseWithSignal } from '../../../../shared/concurrency/abort-signal-reason'
import type { AgentSessionHandoverContext } from '../host/structured-agent-session-host-types'
import type { AgentSessionDispatchOutcome } from '../providers/structured-agent-session-adapter'
import { StructuredAgentSessionInputNotAdmitted } from './structured-agent-session-input-admission'
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'

type DispatchAuthority = { signal?: AbortSignal; isCurrent: () => boolean }

/** Expiry withdraws write authority, never interrupts a turn or retries ambiguous input. */
export async function dispatchWithSteerDeadline(
  ctx: AgentSessionHandoverContext,
  input: DispatchAuthority & { clientMessageId: string; steer: boolean },
  dispatch: (authority: DispatchAuthority) => Promise<AgentSessionDispatchOutcome>
): Promise<AgentSessionDispatchOutcome> {
  const record = ctx.record()
  if (!input.steer || !record || ctx.agents.capabilities(record.provider)?.steering !== 'inject') {
    return dispatch(input)
  }
  const deadline = new AbortController()
  const expired = new Error('Steer delivery timed out; receipt is unconfirmed.')
  const signal = input.signal ? AbortSignal.any([input.signal, deadline.signal]) : deadline.signal
  const timer = setTimeout(() => deadline.abort(expired), 30_000)
  timer.unref()
  try {
    const dispatched = dispatch({
      signal,
      isCurrent: () => !deadline.signal.aborted && input.isCurrent()
    })
    try {
      return await waitForPromiseWithSignal(dispatched, deadline.signal)
    } catch (error) {
      if (error !== expired) {
        throw error
      }
      void dispatched
        .catch((error: unknown) => {
          const outcome =
            error instanceof StructuredAgentSessionInputNotAdmitted ? error.outcome : undefined
          // Deadline withdrawal is a send failure with explicit retry, never the user's Stop.
          return outcome?.rejection?.kind === 'cancelled' &&
            outcome.rejection.neverReachedAgent &&
            !input.signal?.aborted
            ? {
                state: 'rejected' as const,
                ...agentSessionFailureWords(
                  agentSessionFailureFact('writeFailed', { neverReachedAgent: true }),
                  { ...ctx.failureTextContext, surface: 'rejection' }
                )
              }
            : outcome
        })
        .then(async (outcome) => {
          if (outcome?.state === 'accepted' || outcome?.state === 'rejected') {
            await ctx.journal.settleLateDispatch({
              ...outcome,
              clientMessageId: input.clientMessageId,
              fence: ctx.record()?.lease.runtimeFence ?? ctx.fence
            })
          }
        })
        // A replaced/closed journal cannot accept this old attempt's late proof.
        .catch(() => {})
      return { state: 'unknown', reason: expired.message }
    }
  } finally {
    clearTimeout(timer)
  }
}
