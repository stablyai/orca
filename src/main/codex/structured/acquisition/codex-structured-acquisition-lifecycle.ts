import type { acquireCodexStructuredSession } from './codex-structured-session-acquire'
import type { CodexStructuredLaunch } from '../session-lifecycle/codex-structured-session-state'
import '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import {
  AgentSessionAcquisitionExitUnprovenError,
  AgentSessionAcquisitionRootExitObservedError
} from '../../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import { isCodexAppServerHandshakeExitUnprovenError } from '../../app-server/codex-app-server-handshake-exit-proof'
import {
  cancelCodexAcquisitionAttempt,
  type CodexAcquisitionAttempt,
  type CodexAcquisitionRegistry
} from '../session-lifecycle/codex-structured-session-state'

export async function stopSupersededCodexAcquisition(input: {
  sessionId: string
  registry: CodexAcquisitionRegistry
  replacement: CodexAcquisitionAttempt
  previous: CodexAcquisitionAttempt | undefined
}): Promise<void> {
  try {
    if (!(await cancelCodexAcquisitionAttempt(input.previous))) {
      throw new AgentSessionAcquisitionExitUnprovenError(
        new Error(`codex acquisition for session ${input.sessionId} could not be stopped`)
      )
    }
  } catch (error) {
    if (input.previous) {
      input.registry.restoreIfCurrent(input.sessionId, input.replacement, input.previous)
    }
    throw error
  }
}

export async function closeFailedCodexAcquisition(input: {
  sessionId: string
  registry: CodexAcquisitionRegistry
  attempt: CodexAcquisitionAttempt
  cause: unknown
  dispose: () => void
}): Promise<never> {
  if (isCodexAppServerHandshakeExitUnprovenError(input.cause)) {
    input.attempt.window.connection = input.cause.connection
  }
  input.dispose()
  try {
    if (!(await input.registry.closeFailedAttempt(input.sessionId, input.attempt))) {
      throw new AgentSessionAcquisitionExitUnprovenError(input.cause)
    }
  } catch (cleanupError) {
    if (cleanupError instanceof AgentSessionAcquisitionExitUnprovenError) {
      throw cleanupError
    }
    throw new AgentSessionAcquisitionExitUnprovenError(
      new AggregateError([input.cause, cleanupError], 'codex acquisition cleanup failed')
    )
  }
  if (
    input.attempt.window.connection?.closeResult?.killDelivered &&
    input.attempt.window.connection.closeResult.root !== 'exited'
  ) {
    throw new AgentSessionAcquisitionRootExitObservedError(input.cause, 'kill-delivered')
  }
  throw input.cause
}

export function bindCodexExecutionDeadline(
  input: Parameters<typeof acquireCodexStructuredSession>[0],
  execution: CodexStructuredLaunch['execution'],
  attempt: CodexAcquisitionAttempt,
  generation: string
): void {
  const sessionId = input.input.identity.sessionId
  const acquisition = attempt.window
  acquisition.startExecution(
    execution,
    async () => {
      attempt.cancelled = true
      attempt.requestedClose = false
      const connection = acquisition.connection
      if (!connection) {
        return false
      }
      const current = input.sessions.get(sessionId)
      const published =
        current?.connection === connection &&
        current.fence === input.input.fence &&
        current.acquisitionGeneration === generation
      if (current?.connection === connection && !published) {
        return false
      }
      const completed = acquisition.execution?.turnCompleted && !acquisition.execution.invalidated
      const closed = published
        ? completed
          ? await input.closeCompleted(sessionId)
          : await input.forceCloseUnexpected(
              sessionId,
              input.input.fence,
              generation,
              new Error(
                acquisition.execution?.invalidated
                  ? 'Bounded Codex controls changed.'
                  : 'Bounded Codex deadline reached.'
              )
            )
        : await connection.close()
      return (
        closed &&
        connection.closeResult?.root === 'exited' &&
        connection.closeResult.tree === 'exited'
      )
    },
    () =>
      input.deps.logger?.warn('Bounded Codex process exit unproven.', {
        scope: 'codex.execution',
        sessionId
      })
  )
  if (acquisition.execution) {
    acquisition.execution.record = input.deps.onExecutionReceipt
    acquisition.execution.binding = {
      sessionId,
      fence: input.input.fence,
      generation,
      spawnToken: input.input.spawnToken
    }
    acquisition.execution.reporter = input.deps.prepareExecutionReporter?.({
      sessionId,
      fence: input.input.fence,
      spawnToken: input.input.spawnToken,
      currentGeneration: () => {
        const current = input.sessions.get(sessionId)
        return current && !current.ended ? current.acquisitionGeneration : null
      }
    })
  }
}
