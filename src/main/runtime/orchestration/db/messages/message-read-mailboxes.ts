import type { OrchestrationDb } from '../orchestration-db'

export const MESSAGE_ID_UPDATE_BATCH_SIZE = 500

/** The mailboxes whose unread mail these ids are, read before a consuming mutation marks them read. */
export function unreadMailboxesOf(db: OrchestrationDb, ids: string[]): string[] {
  const mailboxes = new Set<string>()
  for (let offset = 0; offset < ids.length; offset += MESSAGE_ID_UPDATE_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MESSAGE_ID_UPDATE_BATCH_SIZE)
    for (const row of db.db
      .prepare(
        `SELECT DISTINCT to_handle FROM messages WHERE read = 0 AND id IN (${batch.map(() => '?').join(',')})`
      )
      .all(...batch)) {
      if (typeof row?.to_handle === 'string') {
        mailboxes.add(row.to_handle)
      }
    }
  }
  return [...mailboxes]
}
