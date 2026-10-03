// Moves a rest rig chat's history out of the host's database into its own per-chat file, as a
// build before the shared database left it: the format an upgrade finds before the copy.

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import Database from '../../sqlite/sync-database'
import {
  liveTestJournalRows,
  openTestJournalHostDatabase
} from '../agent-session-journal/journal-host-database-test-support'
import { legacyJournalDatabaseFile } from '../agent-session-journal/journal-paths'
import type { RestTestRig } from './structured-agent-session-rest-test-rig'

export async function moveRestTestChatToPerChatFile(
  rig: RestTestRig,
  sessionId: string
): Promise<void> {
  const host = openTestJournalHostDatabase(rig.root)
  const rows = liveTestJournalRows(host.db, sessionId)
  const workspaceId = rig.store.getRecord(sessionId)!.location.workspaceId
  const path = legacyJournalDatabaseFile(host.legacyDirectoryFor({ workspaceId, sessionId }))
  await mkdir(dirname(path), { recursive: true })
  const file = new Database(path)
  try {
    file.pragma('journal_mode = WAL')
    file.exec(`
CREATE TABLE journal_rows (session_id TEXT NOT NULL, epoch TEXT NOT NULL, seq INTEGER NOT NULL,
  ts INTEGER NOT NULL, row_json TEXT NOT NULL, PRIMARY KEY (session_id, epoch, seq));
CREATE TABLE journal_sessions (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE journal_repairs (session_id TEXT PRIMARY KEY, epoch TEXT NOT NULL,
  content_from INTEGER NOT NULL, repaired_at INTEGER NOT NULL);`)
    file.pragma('user_version = 2')
    const insert = file.prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(sessionId, row.epoch, row.seq, row.ts, row.rowJson)
    }
    file.prepare('INSERT INTO journal_sessions VALUES (?, ?, ?)').run(sessionId, rows[0]!.epoch, 1)
  } finally {
    file.close()
  }
  for (const table of ['journal_rows', 'journal_sessions', 'journal_session_state']) {
    host.db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId)
  }
}
