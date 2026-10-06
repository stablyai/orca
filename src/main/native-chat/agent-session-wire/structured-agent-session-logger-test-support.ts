import {
  createStructuredAgentSessionLogger,
  type StructuredAgentSessionLogFields,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'

export type RecordedStructuredAgentSessionLog = {
  level: keyof StructuredAgentSessionLogger
  message: string
  fields: StructuredAgentSessionLogFields
}

/** A logger that keeps every entry, for tests that assert a failure was reported. */
export function recordingStructuredAgentSessionLogger(): {
  logger: StructuredAgentSessionLogger
  entries: RecordedStructuredAgentSessionLog[]
  scopes: () => string[]
} {
  const entries: RecordedStructuredAgentSessionLog[] = []
  return {
    logger: {
      warn: (message, fields) => entries.push({ level: 'warn', message, fields }),
      error: (message, fields) => entries.push({ level: 'error', message, fields })
    },
    entries,
    scopes: () => entries.map((entry) => entry.fields.scope)
  }
}

/** A recording logger that also prints as production does, for a harness whose tests read either:
 *  the entries hold every level and every field, whatever the console mirror keeps. */
export function recordingProductionStructuredAgentSessionLogger(): ReturnType<
  typeof recordingStructuredAgentSessionLogger
> {
  const recording = recordingStructuredAgentSessionLogger()
  const production = createStructuredAgentSessionLogger()
  return {
    ...recording,
    logger: {
      warn: (message, fields) => {
        recording.logger.warn(message, fields)
        production.warn(message, fields)
      },
      error: (message, fields) => {
        recording.logger.error(message, fields)
        production.error(message, fields)
      }
    }
  }
}

/** What an event sink built outside a host needs: the session it writes for, and a logger. */
export function testEventSinkLogging(sessionId = 'session-1'): {
  sessionId: string
  logger: StructuredAgentSessionLogger
} {
  return { sessionId, logger: recordingStructuredAgentSessionLogger().logger }
}
