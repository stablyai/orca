import { claudeCloseReport, claudeAcquisitionCleanupError } from './claude-structured-close-report'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeInitProof } from './structured/claude-structured-init-proof'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeSession,
  ClaudeAcquireCallbacks
} from './structured/claude-structured-session-state'

export function createClaudeSessionJournalTranslator(
  sink: StructuredAgentSessionEventSink | undefined,
  fallbackIdPrefix: string,
  failure: Parameters<typeof createClaudeJournalFailureHandler>[0],
  currentSession: () => ClaudeSession | null
): ClaudeJournalTranslator | null {
  const { attempt } = failure
  const translator = sink
    ? createClaudeJournalTranslator({
        sink,
        account: () => attempt.account,
        model: () => {
          const session = currentSession()
          return (
            session?.appliedInputOptions.get('model') ??
            session?.options.get('model') ??
            session?.launchIntent?.model ??
            session?.reportedOptions.model
          )
        },
        fallbackIdPrefix,
        goalBackgroundWork: () =>
          currentSession()?.backgroundTasks.goalBackgroundWork ?? 'unverifiable',
        onBackgroundTaskJournalFailure: createClaudeJournalFailureHandler(failure),
        bindPromptItemId: (itemId, promptKey) =>
          attempt.prompts.bindJournalItemId(itemId, promptKey)
      })
    : null
  attempt.dispose = () => {
    for (const event of attempt.buffered.splice(0)) {
      event()
    }
    translator?.dispose()
  }
  return translator
}

export function createClaudeJournalFailureHandler(input: {
  attempt: ClaudeAcquisitionAttempt
  initProof: ClaudeInitProof
  callbacks: ClaudeAcquireCallbacks
  sessionId: string
}): (error: Error) => void {
  return (error) => {
    if (!input.attempt.published) {
      input.initProof.reject(error)
      return
    }
    const connection = input.attempt.connection
    if (connection) {
      void connection.closeOutcome().then(
        (outcome) =>
          input.callbacks.handleExit(
            input.sessionId,
            input.attempt,
            claudeCloseReport(connection, outcome, error) ?? error
          ),
        (cleanupError: unknown) =>
          input.callbacks.handleExit(
            input.sessionId,
            input.attempt,
            claudeAcquisitionCleanupError(
              connection,
              new AggregateError([error, cleanupError], error.message)
            )
          )
      )
    }
  }
}

// Retry on drain because the provider may send no further events.
function retryOwedWritesOnDrain(
  translator: ClaudeJournalTranslator | null
): StructuredAgentSessionSinkAdmission {
  const tasks = translator?.retryPendingTaskRows?.() ?? { accepted: true }
  if (!tasks.accepted && tasks.reason === 'backpressure') {
    return tasks
  }
  return translator?.retryPendingCancellations?.() ?? { accepted: true }
}

export function bindClaudeJournalReadingControl(
  sink: StructuredAgentSessionEventSink | undefined,
  connection: Pick<ClaudeStreamJsonConnection, 'pauseReading' | 'resumeReading'>,
  translator: ClaudeJournalTranslator | null
): (() => void) | undefined {
  if (!connection.pauseReading || !connection.resumeReading) {
    return undefined
  }
  let sinkPaused = false
  return sink?.bindReadingControl?.({
    pauseReading: () => {
      sinkPaused = true
      connection.pauseReading?.()
    },
    resumeReading: () => {
      sinkPaused = false
      const retried = retryOwedWritesOnDrain(translator)
      if (!sinkPaused && (retried.accepted || retried.reason !== 'backpressure')) {
        connection.resumeReading?.()
      }
    }
  })
}
