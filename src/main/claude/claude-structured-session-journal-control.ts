import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { createClaudeInitDeadline } from './claude-structured-init-deadline'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeAcquireCallbacks
} from './claude-structured-session-state'

export function createClaudeJournalFailureHandler(input: {
  attempt: ClaudeAcquisitionAttempt
  initDeadline: ReturnType<typeof createClaudeInitDeadline>
  callbacks: ClaudeAcquireCallbacks
  sessionId: string
}): (error: Error) => void {
  return (error) => {
    if (!input.attempt.published) {
      input.initDeadline.reject(error)
      return
    }
    const connection = input.attempt.connection
    if (connection) {
      void connection
        .close()
        .catch(() => false)
        .finally(() => input.callbacks.handleExit(input.sessionId, input.attempt, error))
    }
  }
}

export function bindClaudeJournalReadingControl(
  sink: StructuredAgentSessionEventSink | undefined,
  connection: ClaudeStreamJsonConnection,
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
      const retried = translator?.retryPendingTaskRows?.() ?? { accepted: true }
      if (!sinkPaused && (retried.accepted || retried.reason !== 'backpressure')) {
        connection.resumeReading?.()
      }
    }
  })
}
