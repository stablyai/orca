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

/** An observed exit still requires connection cleanup; absence alone cannot prove release. */
export async function releaseClaudeAcquisition(input: {
  sessionId: string
  sessions: Map<string, ClaudeSession>
  acquisitions: ClaudeAcquisitionRegistry
  exits: Map<string, ClaudeSessionExit>
  onExitProven?: (sessionId: string, exit: ClaudeSessionExit) => Promise<void>
  persistHandle?: ClaudeStructuredSessionAdapterDeps['persistHandle']
  onEvent?: ClaudeStructuredSessionAdapterDeps['onEvent']
}): Promise<boolean> {
  const exit = input.exits.get(input.sessionId)
  if (!exit || input.sessions.has(input.sessionId) || input.acquisitions.get(input.sessionId)) {
    return closeClaudeSession(input)
  }
  const firstProof = exit.closePromise ? await exit.closePromise : false
  // Retry tree verification on the same connection after an unproven close.
  const retriedProof = firstProof || (await exit.connection.close())
  if (retriedProof) {
    await input.onExitProven?.(input.sessionId, exit)
    // Retain unproven exits for retries; observed root exits are removed by their own settlement.
    input.exits.delete(input.sessionId)
    return true
  }
  throw claudeAcquisitionCleanupError(exit.connection, exit.error)
}
