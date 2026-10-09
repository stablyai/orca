import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'

/** Registered while the child is selected; awaited after releasing the session lane. */
export function prepareStructuredAgentSessionDispatch(
  adapter: StructuredAgentSessionAdapter,
  aborts: StructuredAgentSessionAcquireAborts,
  sessionId: string
): Promise<boolean> | undefined {
  const preparation = adapter.prepareDispatch?.(sessionId)
  if (!preparation) {
    return undefined
  }
  const wait = aborts.begin(sessionId)
  return waitForPromiseWithSignal(preparation, wait.signal)
    .then(() => !wait.signal.aborted)
    .catch((error: unknown) => {
      if (wait.signal.aborted) {
        return false
      }
      throw error
    })
    .finally(wait.end)
}
