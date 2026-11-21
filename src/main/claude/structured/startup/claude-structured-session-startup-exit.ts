import { isClaudeQueryClosed } from '../../sdk-transport/claude-agent-sdk-control-requests'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import {
  providerExitObserved,
  startupAcquisitionRefusal,
  withObservedProviderExit
} from '../../../native-chat/agent-session-wire/startup/structured-agent-session-failure-text'
import type { ClaudeStreamJsonConnection } from '../../claude-stream-json-connection'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { claudeStartFailure, claudeStartupAnswer } from '../../sdk-transport/claude-startup-failure'
import type { AgentSessionStartFailure } from '../../../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import type { ClaudeAcquisitionAttempt } from '../claude-structured-session-state'
import { explainConfiguredCommandExit } from './claude-command-start-failure'

/** A physical exit waits briefly for initialize's answer, which the start's verdict weighs
 *  against the exit; a query closed by that exit is no answer. */
export async function claudeStartupAnswerAfterExit(
  connection: Pick<ClaudeStreamJsonConnection, 'startupFailure'>,
  control: Promise<unknown>,
  exit: unknown
): Promise<AgentSessionStartFailure> {
  const outcome = await withTimeout(
    control.then(
      () => undefined,
      (error: unknown) => error
    ),
    2_000,
    undefined
  )
  return claudeStartFailure([
    connection.startupFailure?.(),
    isClaudeQueryClosed(outcome) ? undefined : outcome,
    exit
  ])
}

/** Orca's own record of the exit an SDK report describes, which carries what ended it, such as a
 *  missing CLI; the start's verdict weighs it against the report. */
export async function claudeExitForReport(
  connection: Pick<ClaudeStreamJsonConnection, 'exited'>,
  error: unknown
): Promise<unknown> {
  return error instanceof Error &&
    (claudeStartupAnswer(error) === 'reported' || isClaudeQueryClosed(error)) &&
    connection.exited
    ? withTimeout<unknown>(connection.exited, 2_000, undefined)
    : undefined
}

/** An exit before publication can follow initialize's answer, which only publication reads. */
type StartupAnswerSource = Pick<
  ClaudeStreamJsonConnection,
  'startupFailure' | 'initializationResult'
>

export async function claudeStartupError(
  observed: unknown,
  attempt: Pick<ClaudeAcquisitionAttempt, 'launch' | 'published'> & {
    connection: StartupAnswerSource | null
  }
): Promise<unknown> {
  const answered = await weighClaudeStartupAnswer(observed, attempt.connection)
  // Only a start is explained, after Claude's own answer: a published session's exit is no longer about its Command.
  return attempt.published ? answered : explainConfiguredCommandExit(answered, attempt.launch)
}

async function weighClaudeStartupAnswer(
  error: unknown,
  connection: StartupAnswerSource | null
): Promise<unknown> {
  const refusal = startupAcquisitionRefusal(error)
  if (refusal || !connection) {
    return refusal ?? error
  }
  if (providerExitObserved(error)) {
    return claudeStartupAnswerAfterExit(connection, connection.initializationResult(), error)
  }
  const result = connection.startupFailure?.()
  return result ? claudeStartFailure([result, error]) : error
}

/** An unexpected exit, and when it ends the start: a delivered initialize answer outranks it. The
 *  start's root-exit receipt is taken now, before the answer join can delay it. */
export function claudeStartupExit(
  error: Error,
  attempt: Pick<ClaudeAcquisitionAttempt, 'connection' | 'launch' | 'published'>,
  events?: Pick<StructuredAgentSessionEventSink, 'observeRootExit'>
): [exited: Error, ended: Promise<unknown>] {
  events?.observeRootExit?.()
  // Mark in place because the fault report may retain this error object.
  const exited = withObservedProviderExit(error)
  return [exited, claudeStartupError(exited, attempt)]
}
