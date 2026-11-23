import { randomUUID } from 'node:crypto'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type Database from '../../sqlite/sync-database'
import { isDiskAlmostFull } from '../../../shared/diagnostics/perf-notice-signals'
import { journalLegacyConversionSource } from './database/journal-legacy-source'

export type JournalConversionStorage = {
  freeBytes: number
  totalBytes: number
  remainingBytes?: number
  /** The original's state the chat's size holds for; a match means the caller's size still stands. */
  sizedAt?: string
}

const connections = new WeakMap<Database.Database, string>()

/**
 * Space the volume gives this user, and with a chat the bytes its original history holds. One chat
 * at a time, not the whole original: a mostly converted journal would otherwise defer for good.
 * Null when the volume can't be measured. A chat sized at `sizedAt`, with no commit to the
 * original since, isn't read again.
 */
export async function measureJournalConversionStorage(
  filename: string,
  source: Database.Database | undefined,
  destination: Database.Database,
  sessionId?: string,
  sizedAt?: string
): Promise<JournalConversionStorage | null> {
  // The folder, so a missing original still measures its volume and converts nothing as before.
  const volume = await statfs(dirname(filename)).catch(() => null)
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
  // data_version changes when another connection commits, and each connection gets its own id.
  let connection = connections.get(source)
  if (!connection) {
    connection = randomUUID()
    connections.set(source, connection)
  }
  const at = `${connection}:${Number(source.pragma('data_version', { simple: true }))}`
  if (at === sizedAt) {
    return { ...storage, sizedAt: at }
  }
  // A copy converts from its original chat; octet_length sizes TEXT without loading it. A chat
  // whose history lives in its outcome generation restores each key's newest record there, so
  // that counts, not the revisions it superseded.
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
        WHERE e.session_id=? AND o.seq=(SELECT n.seq FROM journal_outcomes n
          WHERE n.generation=o.generation AND n.field=o.field AND n.entry_key=o.entry_key
            AND n.seq<=e.through_seq ORDER BY n.seq DESC LIMIT 1)`)
    : 0
  return { ...storage, remainingBytes: rows + outcomes, sizedAt: at }
}
