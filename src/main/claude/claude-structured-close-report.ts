import type {
  ClaudeStreamJsonConnection,
  ClaudeCloseOutcome
} from './claude-stream-json-connection'
import {
  AgentSessionPreSpawnError,
  AgentSessionAcquisitionRootExitObservedError,
  AgentSessionAcquisitionExitUnprovenError
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'

/** Root exit releases the lease even with unverified descendants; a failed spawn proves no exit. */
export function claudeRootExitObserved(
  connection: ClaudeStreamJsonConnection | null | undefined
): boolean {
  const verdict = connection?.exitVerdict
  return verdict?.root === 'exited' && verdict.processless !== true
}

export function claudeAcquisitionCleanupError(
  connection: ClaudeStreamJsonConnection | null | undefined,
  cause: unknown,
  verdict = connection?.exitVerdict
): Error {
  return verdict?.processless === true
    ? new AgentSessionPreSpawnError(cause)
    : verdict?.root === 'exited' || verdict?.killDelivered
      ? new AgentSessionAcquisitionRootExitObservedError(
          cause,
          verdict?.root === 'exited' ? 'exit-observed' : 'kill-delivered'
        )
      : new AgentSessionAcquisitionExitUnprovenError(cause)
}

/** Completion and physical evidence are separate answers on a writer-terminal close. */
export function claudeCloseReport(
  connection: ClaudeStreamJsonConnection | null | undefined,
  outcome: ClaudeCloseOutcome | undefined,
  cause: unknown
): Error | undefined {
  if (!connection || !outcome) {
    return undefined
  }
  if (outcome.receive.state === 'failed' && outcome.receive.error !== cause) {
    cause = new AggregateError(
      [cause, outcome.receive.error],
      cause instanceof Error ? cause.message : String(cause)
    )
  }
  const verdict = outcome.physical
  if (
    outcome.accepted &&
    outcome.receive.state === 'complete' &&
    !verdict?.processless &&
    (verdict?.root === 'exited' || !verdict?.killDelivered)
  ) {
    return undefined
  }
  return claudeAcquisitionCleanupError(connection, cause, outcome.physical)
}
