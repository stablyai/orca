import { statfs } from 'node:fs/promises'
import type Database from '../../sqlite/sync-database'
import { isDiskAlmostFull } from '../../../shared/diagnostics/perf-notice-signals'
import { journalLegacyConversionSource } from './database/journal-legacy-source'

export type JournalConversionStorage = {
  freeBytes: number
  totalBytes: number
  remainingBytes?: number
}

/**
 * Space the volume gives this user, and with a chat the bytes its original rows hold. One chat at
 * a time, not the whole original: a mostly converted journal would otherwise defer for good.
 * Null when the volume can't be measured.
 */
export async function measureJournalConversionStorage(
  filename: string,
  source: Database.Database | undefined,
  destination: Database.Database,
  sessionId?: string
): Promise<JournalConversionStorage | null> {
  const volume = await statfs(filename).catch(() => null)
  if (!volume) {
    return null
  }
  const storage = {
    freeBytes: Number(volume.bavail) * Number(volume.bsize),
    totalBytes: Number(volume.blocks) * Number(volume.bsize)
  }
  // Below the floor the chat defers whatever its size, so its rows aren't read.
  if (sessionId === undefined || isDiskAlmostFull(storage)) {
    return storage
  }
  if (!source) {
    return { ...storage, remainingBytes: 0 }
  }
  // A copy converts from its original chat; octet_length sizes TEXT without loading it. A chat
  // whose history lives in its outcome generation restores that too, so it counts.
  const from = journalLegacyConversionSource(destination, sessionId)
  const bytes = (sql: string) => Number(source.prepare(sql).get(from)?.bytes ?? 0)
  const rows = bytes(
    'SELECT COALESCE(SUM(octet_length(row_json)),0) AS bytes FROM journal_rows WHERE session_id=?'
  )
  const outcomes = source
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal_outcome_epochs'")
    .get()
    ? bytes(`SELECT COALESCE(SUM(octet_length(o.value_json)),0) AS bytes
        FROM journal_outcome_epochs e JOIN journal_outcomes o ON o.generation=e.generation
        WHERE e.session_id=?`)
    : 0
  return { ...storage, remainingBytes: rows + outcomes }
}
