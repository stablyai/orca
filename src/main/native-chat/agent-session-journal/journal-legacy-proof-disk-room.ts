import { statfsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDiskAlmostFull } from '../../../shared/diagnostics/perf-notice-signals'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import type Database from '../../sqlite/sync-database'

export const LEGACY_LOW_DISK_MESSAGE =
  'the disk is almost full, so converting old chats waits for free space'
/** Store bytes per byte of old journal converted: measured, a 20.8 GB journal grew the store 31.1 GB. */
const LEGACY_CONVERSION_GROWTH = 1.5

/**
 * The proof converts every chat the store lacks before the old file can go, and the old file stays
 * meanwhile (a 20.8 GB file grew the store to 31 GB). Each page waits while the disk is almost full
 * rather than filling it; the proof resumes where it paused.
 */
export class JournalLegacyLowDiskError extends Error {
  constructor() {
    super(LEGACY_LOW_DISK_MESSAGE)
    this.name = 'JournalLegacyLowDiskError'
  }
}

async function assertLegacyProofDiskRoom(directory: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof statfs>>
  try {
    stats = await statfs(directory)
  } catch {
    // A volume that can't say how full it is doesn't hold the proof up.
    return
  }
  const block = Number(stats.bsize)
  if (
    isDiskAlmostFull({
      freeBytes: Number(stats.bavail) * block,
      totalBytes: Number(stats.blocks) * block
    })
  ) {
    throw new JournalLegacyLowDiskError()
  }
}

/** The proof's pacing gate, which also waits while the profile's disk is almost full. */
export function withLegacyProofDiskRoom(
  directory: string,
  boundary: () => Promise<boolean>
): () => Promise<boolean> {
  return async () => {
    if (!(await boundary())) {
      return false
    }
    await assertLegacyProofDiskRoom(directory)
    return true
  }
}

/**
 * On a run's first page, in the reader: the proof starts only if converting what the store still
 * lacks (about 1.5x that share of the journal) leaves the disk above the floor. A partial store
 * would hold disk the user can't get back while the old file is kept.
 */
export function assertLegacyProofFits(source: Database.Database, store: Database.Database): void {
  let free: number
  let total: number
  let needed: number
  try {
    const file = store
      .prepare('PRAGMA database_list')
      .all()
      .find((row) => row.name === 'main')?.file
    if (!file) {
      return
    }
    const stats = statfsSync(dirname(String(file)))
    const block = Number(stats.bsize)
    free = Number(stats.bavail) * block
    total = Number(stats.blocks) * block
    const bytes =
      Number(source.pragma('page_count', { simple: true })) *
      Number(source.pragma('page_size', { simple: true }))
    const chats = Number(source.prepare('SELECT COUNT(*) AS n FROM journal_sessions').get()?.n ?? 0)
    const converted = Number(
      store.prepare('SELECT COUNT(*) AS n FROM journal_chat_state WHERE epoch IS NOT NULL').get()
        ?.n ?? 0
    )
    needed =
      chats > 0 ? (LEGACY_CONVERSION_GROWTH * bytes * Math.max(0, chats - converted)) / chats : 0
  } catch {
    // What can't be measured doesn't hold the proof up; each page still checks the floor.
    return
  }
  if (isDiskAlmostFull({ freeBytes: free - needed, totalBytes: total })) {
    throw new JournalLegacyRetentionError(LEGACY_LOW_DISK_MESSAGE)
  }
}
