import {
  closeClaudeSession,
  claudeCloseReport,
  claudeAcquisitionCleanupError
} from '../claude-structured-session-close'
import { AgentSessionAcquisitionExitUnprovenError } from '../../native-chat/agent-session-wire/structured-agent-session-adapter'
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
  logger?: ClaudeStructuredSessionAdapterDeps['logger']
  settledExitErrors?: Map<string, Error>
}): Promise<boolean> {
  const exit = input.exits.get(input.sessionId)
  if (!exit || input.sessions.has(input.sessionId) || input.acquisitions.get(input.sessionId)) {
    return closeClaudeSession(input)
  }
  const firstProof = exit.closePromise ? await exit.closePromise : false
  // Retry tree verification on the same connection after an unproven close.
  const retriedProof = firstProof || (await exit.connection.close())
  const report = claudeCloseReport(exit.connection, retriedProof, exit.error)
  if (retriedProof || (report && !(report instanceof AgentSessionAcquisitionExitUnprovenError))) {
    try {
      await input.onExitProven?.(input.sessionId, exit)
    } catch (error) {
      throw claudeAcquisitionCleanupError(exit.connection, error)
    }
    // Retain unproven exits for retries; observed root exits are removed by their own settlement.
    if (input.exits.get(input.sessionId) === exit) {
      input.exits.delete(input.sessionId)
    }
    if (report) {
      throw report
    }
    return true
  }
  throw report
}
