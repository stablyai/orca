import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionProviderChildIdentity } from './structured-agent-session-host-types'
import {
  settleStructuredAgentSessionProviderStarted,
  type StructuredAgentSessionProviderStartedContext
} from './structured-agent-session-provider-started'

/** The host awaits protocol construction without holding the conversation's ordered steps. */
export async function openStructuredAgentSessionProviderChild(
  context: StructuredAgentSessionProviderStartedContext & {
    failStartingChild: (
      sessionId: string,
      child: StructuredAgentSessionProviderChildIdentity,
      error: unknown
    ) => Promise<void>
  },
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity
): Promise<void> {
  const open = context.deps.adapter.open
  if (!open || !context.runtimeState.startupAttempts.onClock(sessionId, child)) {
    return
  }
  const attempt = context.runtimeState.acquireAborts.begin(sessionId)
  try {
    attempt.signal.throwIfAborted()
    const result = await waitForPromiseWithSignal(
      open.call(context.deps.adapter, {
        sessionId,
        fence: child.fence,
        acquisitionGeneration: child.generation,
        signal: attempt.signal
      }),
      attempt.signal
    )
    if (attempt.signal.aborted) {
      return
    }
    await settleStructuredAgentSessionProviderStarted(
      context,
      {
        ...result,
        type: 'started',
        sessionId,
        fence: child.fence,
        acquisitionGeneration: child.generation ?? ''
      },
      attempt.signal
    )
  } catch (error) {
    // Stop, close, quit and expiry already own the child's end.
    if (!attempt.signal.aborted) {
      await context.failStartingChild(sessionId, child, error).catch((closeError: unknown) =>
        context.deps.logger.warn('closing a failed provider open did not finish', {
          scope: 'provider-open-close',
          sessionId,
          error: closeError
        })
      )
    }
  } finally {
    attempt.end()
  }
}
