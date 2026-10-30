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

/** Retain every entry/field while mirroring production console output. */
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

export function testEventSinkLogging(sessionId = 'session-1'): {
  sessionId: string
  logger: StructuredAgentSessionLogger
} {
  return { sessionId, logger: recordingStructuredAgentSessionLogger().logger }
}
