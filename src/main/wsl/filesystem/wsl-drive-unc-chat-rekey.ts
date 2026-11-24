import { isRecord } from '../../../shared/orcad-migration/orcad-migration-manifest-fields'
import type Database from '../../sqlite/sync-database'

/** Head and record identities change inside the writer's existing transaction. */
export function rekeyWslDriveUncChats(
  db: Database.Database,
  worktreeIds: readonly (readonly [string, string])[]
): boolean {
  const ids = new Map(worktreeIds)
  const head = db.prepare('UPDATE journal_chat_state SET workspace_id = ? WHERE workspace_id = ?')
  for (const [oldId, newId] of ids) {
    head.run(newId, oldId)
  }
  const update = db.prepare('UPDATE agent_session_records SET record_json = ? WHERE session_id = ?')
  for (const row of db.prepare('SELECT session_id, record_json FROM agent_session_records').all()) {
    const next = typeof row.record_json === 'string' ? rekeyChatRecord(row.record_json, ids) : null
    if (next !== null) {
      update.run(next, row.session_id)
    }
  }
  return true
}

/** Unreadable records stay byte-identical. */
function rekeyChatRecord(json: string, ids: ReadonlyMap<string, string>): string | null {
  let record: unknown
  try {
    record = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(record) || !isRecord(record.location)) {
    return null
  }
  const workspaceId = record.location.workspaceId
  const next = typeof workspaceId === 'string' ? ids.get(workspaceId) : undefined
  return next
    ? JSON.stringify({ ...record, location: { ...record.location, workspaceId: next } })
    : null
}
