// What a failed journal open means for the chat: its history is damaged, which no retry reads
// past, or the open failed in a way that can clear (a lock, permissions, too many open files).

import type { AgentSessionRefusalReason } from '../../../shared/agent-session-refusal-details'
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
