// Opening the chat journal database for the host install.

import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { journalOpenRefusalError } from '../native-chat/agent-session-journal/journal-open-failure'
import { recordStructuredAgentSessionHostInstallRefusal } from './structured-agent-session-host-refusal'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

// Every chat request retries a failed open, so each distinct failure is logged once, with its stack.
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

/** The journal database. A refusal is recorded for the gate and thrown to the caller; the next
 *  install tries again. */
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
    // Nothing is renamed, deleted or rebuilt: the file is left exactly as it is.
    const refusal = journalOpenRefusalError(error)
    recordStructuredAgentSessionHostInstallRefusal(refusal)
    throw refusal
  }
}
