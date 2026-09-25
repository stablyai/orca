import {
  closeClaudeSession,
  claudeAcquisitionCleanupError
} from './claude-structured-session-close'
import type {
  ClaudeAcquisitionRegistry,
  ClaudeSession,
  ClaudeSessionExit,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

/**
 * Cleanup for an acquisition the host could not commit or prove. A session that
 * a first-hand exit already removed is not an absence to report as proven: the
 * ladder on its connection still answers, and that answer is classified exactly
 * as a start-time failure would be.
 */
export async function releaseClaudeAcquisition(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  onExitProven?: (sessionId: string, exit: ClaudeSessionExit) => Promise<void>
  persistHandle?: ClaudeStructuredSessionAdapterDeps['persistHandle']
  onEvent?: ClaudeStructuredSessionAdapterDeps['onEvent']
  onBackgroundTasksChanged?: ClaudeStructuredSessionAdapterDeps['onBackgroundTasksChanged']
}): Promise<boolean> {
  const exit = input.exits.get(input.sessionId)
  if (!exit || input.sessions.has(input.sessionId) || input.acquisitions.get(input.sessionId)) {
    return closeClaudeSession(input)
  }
  const firstProof = exit.closePromise ? await exit.closePromise : false
  // A failed exit-path proof is retained as evidence, not as a terminal result;
  // a release retry must drive a fresh tree verification on the same connection.
  const retriedProof = firstProof || (await exit.connection.close())
  if (retriedProof) {
    await input.onExitProven?.(input.sessionId, exit)
    // Keep the first-hand exit evidence indexed until the tree proof succeeds;
    // a failed close must be retryable and cannot look like an absent session.
    input.exits.delete(input.sessionId)
    return true
  }
  throw claudeAcquisitionCleanupError(exit.connection, exit.error)
}
