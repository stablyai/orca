import { statfs } from 'node:fs/promises'
import type Database from '../../sqlite/sync-database'
import { journalLegacyConversionSource } from './database/journal-legacy-source'

export type JournalConversionStorage = {
  freeBytes: number
  totalBytes: number
  remainingBytes?: number
}

/**
 * Space the volume gives this user, and with a chat the bytes its original rows hold. One chat at
 * a time, not the whole original: a mostly converted journal would otherwise defer for good.
 */
export async function measureJournalConversionStorage(
  filename: string,
  source: Database.Database,
  destination: Database.Database,
  sessionId?: string
): Promise<JournalConversionStorage> {
  const storage = await statfs(filename)
  const free = Number(storage.bavail) * Number(storage.bsize)
  const total = Number(storage.blocks) * Number(storage.bsize)
  if (sessionId === undefined) {
    return { freeBytes: free, totalBytes: total }
  }
  // A copy converts from its original chat; the BLOB cast counts bytes without decoding UTF-8.
  const row = source
    .prepare(
      'SELECT COALESCE(SUM(length(CAST(row_json AS BLOB))),0) AS bytes FROM journal_rows WHERE session_id=?'
    )
    .get(journalLegacyConversionSource(destination, sessionId))
  return { freeBytes: free, totalBytes: total, remainingBytes: Number(row?.bytes ?? 0) }
}
