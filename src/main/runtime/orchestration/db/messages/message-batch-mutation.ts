import type { OrchestrationDb } from '../orchestration-db'

const MESSAGE_ID_UPDATE_BATCH_SIZE = 500
const MESSAGE_MUTATION_SAVEPOINT = 'message_id_mutation'

export function runBatchedMessageMutation(
  db: OrchestrationDb,
  ids: string[],
  sqlForPlaceholders: (placeholders: string) => string,
  leadingBindings: string[] = [],
  consuming = false
): void {
  if (ids.length === 0) {
    return
  }
  const owners = { mailboxes: new Set<string>(), ptyIds: new Set<string>() }
  if (consuming && db.mailReadListener) {
    for (let offset = 0; offset < ids.length; offset += MESSAGE_ID_UPDATE_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + MESSAGE_ID_UPDATE_BATCH_SIZE)
      for (const row of db.db
        .prepare(
          `SELECT to_handle, pointer_pty_id FROM messages WHERE read = 0 AND id IN (${batch.map(() => '?').join(',')})`
        )
        .all(...batch)) {
        if (typeof row.to_handle === 'string') {
          owners.mailboxes.add(row.to_handle)
        }
        if (typeof row.pointer_pty_id === 'string') {
          owners.ptyIds.add(row.pointer_pty_id)
        }
      }
    }
  }
  db.db.exec(`SAVEPOINT ${MESSAGE_MUTATION_SAVEPOINT}`)
  try {
    for (let offset = 0; offset < ids.length; offset += MESSAGE_ID_UPDATE_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + MESSAGE_ID_UPDATE_BATCH_SIZE)
      const placeholders = batch.map(() => '?').join(',')
      db.db.prepare(sqlForPlaceholders(placeholders)).run(...leadingBindings, ...batch)
    }
    db.db.exec(`RELEASE ${MESSAGE_MUTATION_SAVEPOINT}`)
  } catch (error) {
    db.db.exec(`ROLLBACK TO ${MESSAGE_MUTATION_SAVEPOINT}`)
    db.db.exec(`RELEASE ${MESSAGE_MUTATION_SAVEPOINT}`)
    throw error
  }
  if (consuming && (owners.mailboxes.size || owners.ptyIds.size)) {
    try {
      db.mailReadListener?.({ mailboxes: [...owners.mailboxes], ptyIds: [...owners.ptyIds] })
    } catch {
      // Attention cleanup cannot invalidate a committed consuming action.
    }
  }
}
