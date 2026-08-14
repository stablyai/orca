import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import Database from '../sqlite/sync-database'
import { JOURNAL_DB_SCHEMA_VERSION } from '../native-chat/agent-session-journal/journal-database-schema'
import {
  journalDatabaseFile,
  journalDirectoryFor
} from '../native-chat/agent-session-journal/journal-paths'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'

/** A missing transcript alone never authorizes replacing a conversation. */
export async function canStartEmptyClaudeSession(
  record: AgentSessionRecord | null | undefined,
  journalRoot: string
): Promise<boolean> {
  const first = record?.providerHandleChain[0]
  if (
    !record ||
    record.accountHome.variable !== 'CLAUDE_CONFIG_DIR' ||
    first?.origin !== 'created' ||
    first.handle.provider !== 'claude'
  ) {
    return false
  }
  const providerSessionId = first.handle.sessionId
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(providerSessionId)) {
    return false
  }
  if (
    record.providerHandleChain.some(
      (link) =>
        !['created', 'resumed'].includes(link.origin) ||
        link.handle.provider !== 'claude' ||
        link.handle.sessionId !== providerSessionId ||
        link.handle.leafUuid !== null
    )
  ) {
    return false
  }
  try {
    const path = journalDatabaseFile(
      journalDirectoryFor(journalRoot, {
        workspaceId: record.location.workspaceId,
        sessionId: record.sessionId
      })
    )
    const db = new Database(path, { readonly: true, fileMustExist: true })
    try {
      if (db.pragma('user_version', { simple: true }) !== JOURNAL_DB_SCHEMA_VERSION) {
        return false
      }
      // Read all epochs: a replacement or repair must not look like a never-used session.
      const rows = db
        .prepare(`SELECT r.row_json, s.epoch FROM journal_rows r
        JOIN journal_sessions s ON s.session_id = r.session_id
        WHERE r.session_id = ? AND NOT EXISTS
          (SELECT 1 FROM journal_repairs WHERE session_id = r.session_id) LIMIT 2`)
        .all(record.sessionId)
      if (rows.length !== 1) {
        return false
      }
      const parsed = parseJournalRow(String(rows[0].row_json))
      if (
        !parsed.ok ||
        parsed.row.kind !== 'epoch' ||
        parsed.row.reason !== 'session_created' ||
        parsed.row.seq !== 1 ||
        parsed.row.epoch !== rows[0].epoch ||
        parsed.row.providerHandle.kind !== 'claude' ||
        parsed.row.providerHandle.sessionId !== providerSessionId
      ) {
        return false
      }
    } finally {
      db.close()
    }
    // Inspect only the pinned account. Unreadable directories are not evidence of absence.
    const projects = join(record.accountHome.path, 'projects')
    if (!(await stat(record.accountHome.path)).isDirectory()) {
      return false
    }
    const entries = await readdir(projects, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') {
          return []
        }
        throw error
      }
    )
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        return false
      }
      if (!entry.isDirectory()) {
        continue
      }
      try {
        await lstat(join(projects, entry.name, `${providerSessionId}.jsonl`))
        return false
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error
        }
      }
    }
    return true
  } catch {
    return false
  }
}
