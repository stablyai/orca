import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { journalOpenRefusalError } from '../native-chat/agent-session-journal/journal-open-failure'
import { recordStructuredAgentSessionHostInstallRefusal } from './structured-agent-session-host-refusal'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

// Repeated requests retry journal open; log each distinct failure once, including its stack.
let lastLoggedOpenFailure: string | null = null

function logOpenFailureOnce(logger: StructuredAgentSessionLogger, error: unknown): void {
  const failure =
    error instanceof Error
      ? `${'code' in error ? String(error.code) : ''}:${error.message}`
      : String(error)
  if (failure === lastLoggedOpenFailure) {
    return
  }
  lastLoggedOpenFailure = failure
  logger.error('opening the chat journal database failed', {
    scope: 'journal-database-open',
    error
  })
}

/** Record the journal refusal for the gate and throw; the next install retries. */
export function openStructuredAgentSessionJournalDatabase(args: {
  stateDirectory: string
  logger: StructuredAgentSessionLogger
}): JournalHostDatabase {
  try {
    const opened = JournalHostDatabase.open(args.stateDirectory)
    recordStructuredAgentSessionHostInstallRefusal(null)
    lastLoggedOpenFailure = null
    return opened
  } catch (error) {
    logOpenFailureOnce(args.logger, error)
    // Refusal must leave the database file intact.
    const refusal = journalOpenRefusalError(error)
    recordStructuredAgentSessionHostInstallRefusal(refusal)
    throw refusal
  }
}
