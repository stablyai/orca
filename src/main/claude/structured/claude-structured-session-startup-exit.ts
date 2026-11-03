import { isClaudeQueryClosed } from '../claude-agent-sdk-control-requests'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import {
  providerExitObserved,
  startupAcquisitionRefusal,
  withObservedProviderExit
} from '../../native-chat/agent-session-wire/structured-agent-session-failure-text'
import type { ClaudeStreamJsonConnection } from '../claude-stream-json-connection'
import type { StructuredAgentSessionEventSink } from '../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { claudeStartupAnswer } from '../claude-startup-failure'

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
  return (
    connection.startupFailure?.() ??
    (isClaudeQueryClosed(outcome) || reportsClaudeExit(outcome) ? exit : outcome)
  )
}

/** The SDK's report that Claude's process ended is no answer; Orca's own record of that exit
 *  carries what ended it, such as a missing CLI, so a start reads that record instead. */
export async function claudeExitForReport(
  connection: Pick<ClaudeStreamJsonConnection, 'exited'>,
  error: unknown
): Promise<unknown> {
  return reportsClaudeExit(error) && connection.exited
    ? withTimeout<unknown>(connection.exited, 2_000, error)
    : error
}

function reportsClaudeExit(error: unknown): boolean {
  return error instanceof Error && claudeStartupAnswer(error) === 'exited'
}

/** An exit before publication can follow initialize's answer, which only publication reads. */
export async function claudeStartupError(
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

/** An unexpected exit, and when it ends the start: a delivered initialize answer outranks it. The
 *  start's root-exit receipt is taken now, before the answer join can delay it. */
export function claudeStartupExit(
  error: Error,
  connection: ClaudeStreamJsonConnection | null,
  events?: Pick<StructuredAgentSessionEventSink, 'observeRootExit'>
): [exited: Error, ended: Promise<unknown>] {
  events?.observeRootExit?.()
  // Mark in place because the fault report may retain this error object.
  const exited = withObservedProviderExit(error)
  return [exited, claudeStartupError(exited, connection)]
}
