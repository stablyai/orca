// Where a chat's history lived when the journal was one database per chat.
//
// Nothing writes here any more: the host's one database replaced it. The importer copies a file it
// finds here on that chat's first use and deletes it once the copy verifies; the pre-SQLite format
// remnant check looks here too.
// Host-side per-workspace state, keyed by hashed ids — never inside the user's working tree.

import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'

const JOURNAL_DIR_NAME = 'agent-session-journal'

/** Filesystem-safe, collision-resistant segment for an arbitrary id. */
export function journalPathSegment(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

/** `<root>/agent-session-journal/<workspace>/<session>`. */
export function journalDirectoryFor(
  root: string,
  identity: Pick<AgentSessionJournalIdentity, 'workspaceId' | 'sessionId'>
): string {
  return join(
    root,
    JOURNAL_DIR_NAME,
    journalPathSegment(identity.workspaceId),
    journalPathSegment(identity.sessionId)
  )
}

const LEGACY_JOURNAL_DATABASE_FILE = 'journal.db'

/** The per-chat SQLite file inside the directory `journalDirectoryFor` names. */
export function legacyJournalDatabaseFile(journalDir: string): string {
  return join(journalDir, LEGACY_JOURNAL_DATABASE_FILE)
}
