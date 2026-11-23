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
  // A copy converts from its original chat; octet_length sizes TEXT without loading it.
  const from = journalLegacyConversionSource(destination, sessionId)
  const rows = source
    .prepare(
      'SELECT COALESCE(SUM(octet_length(row_json)),0) AS bytes FROM journal_rows WHERE session_id=?'
    )
    .get(from)
  return {
    ...storage,
    remainingBytes: Number(rows?.bytes ?? 0) + outcomeBytes(source, from),
    sizedAt: at
  }
}

/**
 * The bytes of each key's newest outcome record up to the chat's position, the records its restore
 * reads, found key by key the way the restore seeks so superseded revisions are never visited.
 */
function outcomeBytes(source: Database.Database, sessionId: string): number {
  const epochs = source
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='journal_outcome_epochs'")
    .get()
  const epoch =
    epochs &&
    source
      .prepare('SELECT generation, through_seq FROM journal_outcome_epochs WHERE session_id=?')
      .get(sessionId)
  if (!epoch) {
    return 0
  }
  const newest = source.prepare(`SELECT field, entry_key, octet_length(value_json) AS bytes
    FROM journal_outcomes WHERE generation = ? AND (field, entry_key) > (?, ?) AND seq <= ?
    ORDER BY field, entry_key, seq DESC LIMIT 1`)
  let total = 0
  let field = ''
  let key = ''
  for (;;) {
    const row = newest.get(epoch.generation, field, key, epoch.through_seq)
    if (!row) {
      return total
    }
    total += Number(row.bytes)
    field = String(row.field)
    key = String(row.entry_key)
  }
}
