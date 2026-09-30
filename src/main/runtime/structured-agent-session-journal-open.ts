// Opening the chat journal database for the host install.

import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { journalOpenRefusalError } from '../native-chat/agent-session-journal/journal-open-failure'
import { recordStructuredAgentSessionHostInstallRefusal } from './structured-agent-session-host-refusal'

// Every chat request retries a failed open, so each distinct failure is logged once, with its stack.
let lastLoggedOpenFailure: string | null = null

function logOpenFailureOnce(error: unknown): void {
  const failure =
    error instanceof Error
      ? `${'code' in error ? String(error.code) : ''}:${error.message}`
      : String(error)
  if (failure === lastLoggedOpenFailure) {
    return
  }
  lastLoggedOpenFailure = failure
  console.warn('[structured-agent-session] opening the chat journal database failed', error)
}

/** The journal database. A refusal is recorded for the gate and thrown to the caller; the next
 *  install tries again. */
export function openStructuredAgentSessionJournalDatabase(
  stateDirectory: string
): JournalHostDatabase {
  try {
    const opened = JournalHostDatabase.open(stateDirectory)
    recordStructuredAgentSessionHostInstallRefusal(null)
    lastLoggedOpenFailure = null
    return opened
  } catch (error) {
    logOpenFailureOnce(error)
    // Nothing is renamed, deleted or rebuilt: the file is left exactly as it is.
    const refusal = journalOpenRefusalError(error)
    recordStructuredAgentSessionHostInstallRefusal(refusal)
    throw refusal
  }
}
