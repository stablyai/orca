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
      error: unknown,
      openMs?: number
    ) => Promise<void>
  },
  sessionId: string,
  child: StructuredAgentSessionProviderChildIdentity
): Promise<void> {
  if (!context.runtimeState.startupAttempts.onClock(sessionId, child)) {
    return
  }
  const attempt = context.runtimeState.acquireAborts.begin(sessionId)
  const openedAt = context.now()
  try {
    attempt.signal.throwIfAborted()
    const acquisitionGeneration = child.generation
    if (acquisitionGeneration === null) {
      throw new Error('An unopened provider child has no acquisition generation')
    }
    const result = await waitForPromiseWithSignal(
      context.deps.adapter.open({
        sessionId,
        fence: child.fence,
        acquisitionGeneration,
        signal: attempt.signal
      }),
      attempt.signal
    )
    if (attempt.signal.aborted) {
      return
    }
    await settleStructuredAgentSessionProviderStarted(
      context,
      { ...result, sessionId, fence: child.fence, acquisitionGeneration },
      attempt.signal
    )
  } catch (error) {
    // Stop, close, quit and expiry already own the child's end.
    if (!attempt.signal.aborted) {
      const openMs = Math.max(0, context.now() - openedAt)
      await context
        .failStartingChild(sessionId, child, error, openMs)
        .catch((closeError: unknown) =>
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
