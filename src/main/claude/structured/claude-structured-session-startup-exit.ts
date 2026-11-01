import { isClaudeQueryClosed } from '../claude-agent-sdk-control-requests'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  providerExitObserved,
  startupAcquisitionRefusal
} from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { ClaudeStreamJsonConnection } from '../claude-stream-json-connection'

/** A physical exit waits briefly for initialize's answer; a delivered answer outranks the exit. */
export async function claudeStartupAnswerAfterExit(
  connection: Pick<ClaudeStreamJsonConnection, 'startupFailure'>,
  control: Promise<unknown>,
  exit: unknown
): Promise<unknown> {
  const outcome = await withTimeout(
    control.then(
      () => exit,
      (error: unknown) => error
    ),
    2_000,
    exit
  )
  return connection.startupFailure?.() ?? (isClaudeQueryClosed(outcome) ? exit : outcome)
}

/** An exit before publication can follow initialize's answer, which only publication reads. */
export async function claudeAcquisitionStartupError(
  error: unknown,
  connection: ClaudeStreamJsonConnection | null
): Promise<unknown> {
  const refusal = startupAcquisitionRefusal(error)
  if (refusal || !connection) {
    return refusal ?? error
  }
  return providerExitObserved(error)
    ? claudeStartupAnswerAfterExit(connection, connection.initializationResult(), error)
    : (connection.startupFailure?.() ?? error)
}
