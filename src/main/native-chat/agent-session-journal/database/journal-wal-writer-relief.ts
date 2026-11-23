import { statSync } from 'node:fs'
import type Database from '../../../sqlite/sync-database'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'

/** Checkpoint work the serialized SQL writer does itself, only while it is idle with a write waiting. */
export type JournalWalWriterRelief = {
  /** PASSIVE, which returns at once while another connection holds the checkpoint lock. */
  checkpoint(): void
  /** TRUNCATE that never waits on readers; with every frame copied it only shortens the file. */
  truncate(): void
  oversized(): boolean
}

/** Only the SQL writer thread may build this, so its synchronous SQLite and file calls stay off main. */
export function journalWalWriterRelief(
  writer: Database.Database,
  filename: string
): JournalWalWriterRelief {
  const passive = writer.prepare('PRAGMA wal_checkpoint(PASSIVE)')
  const truncate = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)')
  return {
    checkpoint: () => {
      passive.get()
    },
    truncate: () => {
      const timeout = Number(writer.pragma('busy_timeout', { simple: true }))
      writer.pragma('busy_timeout = 0')
      try {
        truncate.get()
      } finally {
        writer.pragma(`busy_timeout = ${timeout}`)
      }
    },
    oversized: () => {
      try {
        return statSync(`${filename}-wal`).size > JOURNAL_SIZE_LIMIT_BYTES
      } catch {
        return false
      }
    }
  }
}
