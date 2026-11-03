import { claudeFocusedPlugin, ClaudePluginInputError } from '../claude-plugin-ui'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeAcquireCallbacks,
  ClaudeSession
} from './claude-structured-session-state'

export function claudePluginUiRecovery(
  {
    attempt,
    callbacks,
    sessionId,
    sessions
  }: {
    attempt: ClaudeAcquisitionAttempt
    callbacks: ClaudeAcquireCallbacks
    sessionId: string
    sessions: ReadonlyMap<string, ClaudeSession>
  },
  current: () => ClaudeSession | null
): (message: Record<string, unknown>) => boolean {
  return (message) => {
    const plugin = claudeFocusedPlugin(message)
    if (plugin === null) {
      return false
    }
    callbacks.deliver(attempt, sessionId, () => {
      const session = current()
      if (
        session &&
        sessions.get(sessionId) === session &&
        session.translator?.openTurnInLiveProviderCycle === true
      ) {
        // A plugin-held tool may never acknowledge interrupt; the exit owner closes the child.
        callbacks.handleExit(sessionId, attempt, new ClaudePluginInputError(plugin))
      }
    })
    return true
  }
}
