// What a failed journal open means for the chat: its history is damaged, which no retry reads
// past, or the open failed in a way that can clear (a lock, permissions, too many open files).

import type { AgentSessionRefusalReason } from '../../../shared/agent-session-refusal-details'
import {
  AgentSessionRefusalError,
  isAgentSessionRefusalError,
  refuse
} from '../../../shared/agent-session-wire-refusals'
import { isSqliteCorruption } from '../../sqlite/sqlite-read-failure'

export type JournalOpenFailure = AgentSessionRefusalReason<'agent_session_journal_unreadable'>

// Bounds a cause chain that loops back on itself.
const MAX_CAUSE_DEPTH = 8

/** Damage only where the storage says so; anything unproven can clear. */
export function classifyJournalOpenFailure(error: unknown): JournalOpenFailure {
  let current = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined; depth += 1) {
    if (isSqliteCorruption(current)) {
      return 'journalCorrupt'
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return 'journalUnavailable'
}

/**
 * What a read throws when the conversation it reaches cannot be opened. The storage's own text
 * (a path, "file is not a database") goes to the log only; the reader gets the classified refusal,
 * whose message stays the bare code.
 */
export function journalOpenReadRefusal(error: unknown): AgentSessionRefusalError {
  if (isAgentSessionRefusalError(error)) {
    return error
  }
  return unreadableRefusal(error, classifyJournalOpenFailure(error), true)
}

const MAX_LOGGED_SESSIONS = 256

/**
 * The read door's refusals for one host. A reader reconnects on a timer while an open can clear,
 * so a session's failure is logged once until that session opens or the failure changes.
 */
export function createJournalOpenReadRefusals() {
  const logged = new Map<string, string>()
  return {
    refusal: (sessionId: string, error: unknown): AgentSessionRefusalError => {
      if (isAgentSessionRefusalError(error)) {
        return error
      }
      const reason = classifyJournalOpenFailure(error)
      const failure = `${reason}:${error instanceof Error ? error.message : String(error)}`
      const repeat = logged.get(sessionId) === failure
      // Past the cap a new session logs every failure rather than evict another's.
      if (!repeat && (logged.has(sessionId) || logged.size < MAX_LOGGED_SESSIONS)) {
        logged.set(sessionId, failure)
      }
      return unreadableRefusal(error, reason, !repeat)
    },
    /** The session opened or closed: its next failure is news. */
    forget: (sessionId: string): void => {
      logged.delete(sessionId)
    }
  }
}

function unreadableRefusal(
  error: unknown,
  reason: JournalOpenFailure,
  log: boolean
): AgentSessionRefusalError {
  if (log) {
    console.warn('[agent-session] opening the conversation for a read failed:', error)
  }
  const code = 'agent_session_journal_unreadable'
  return new AgentSessionRefusalError(refuse(code, { reason }, code), { cause: error })
}
