import {
  bindClaudeContextUsageCapture,
  type ClaudeContextUsageCaptureOptions
} from './claude-context-usage'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-structured-journal-contracts'
import type { ClaudeInitProof } from './claude-structured-session-startup'
import type {
  ClaudeAcquisitionAttempt,
  ClaudeAcquireCallbacks
} from './claude-structured-session-state'

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

/**
 * Every binding an acquisition makes between the connection and the journal:
 * reading control, and the `/context` breakdown the translator asks for. One
 * release covers both.
 */
export function bindClaudeConnectionJournalControls(
  sink: StructuredAgentSessionEventSink | undefined,
  connection: ClaudeStreamJsonConnection,
  translator: ClaudeJournalTranslator | null,
  capture: ClaudeContextUsageCaptureOptions
): (() => void) | undefined {
  const unbinds = [
    bindClaudeJournalReadingControl(sink, connection, translator),
    bindClaudeContextUsageCapture(connection, translator, capture)
  ].filter((unbind): unbind is () => void => unbind !== undefined)
  return unbinds.length === 0
    ? undefined
    : () => {
        for (const unbind of unbinds) {
          unbind()
        }
      }
}
