import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { parseJournalRow } from '../native-chat/agent-session-journal/journal-row-schema'

/** A missing transcript alone never authorizes replacing a conversation. */
export async function canStartEmptyClaudeSession(
  record: AgentSessionRecord | null | undefined,
  database: JournalHostDatabase
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
    if (database.readOnly) {
      return false
    }
    {
      const db = database.db
      // Read all epochs: a replacement or repair must not look like a never-used session.
      const rows = db
        .prepare(`SELECT r.row_json, s.epoch FROM journal_rows r
        JOIN journal_sessions s ON s.session_id = r.session_id
        WHERE r.session_id = ? AND NOT EXISTS
          (SELECT 1 FROM journal_repairs WHERE session_id = r.session_id) ORDER BY r.seq`)
        .iterate(record.sessionId)
      let hasEpoch = false
      for (const row of rows) {
        const parsed = parseJournalRow(String(row.row_json))
        if (!parsed.ok || parsed.row.epoch !== row.epoch) {
          return false
        }
        // A queued first send precedes acquisition; a dispatch proves the session was used.
        if (hasEpoch && parsed.row.kind === 'submission' && parsed.row.handoverRecorded) {
          continue
        }
        if (
          hasEpoch ||
          parsed.row.kind !== 'epoch' ||
          parsed.row.reason !== 'session_created' ||
          parsed.row.seq !== 1 ||
          parsed.row.providerHandle.kind !== 'claude' ||
          parsed.row.providerHandle.sessionId !== providerSessionId
        ) {
          return false
        }
        hasEpoch = true
      }
      if (!hasEpoch) {
        return false
      }
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
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
          throw error
        }
      }
    }
    return true
  } catch {
    return false
  }
}
