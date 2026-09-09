import type SyncDatabase from '../sqlite/sync-database'

const GENERATION_KEY = 'index_generation'

/**
 * A monotone id for what the index currently publishes.
 *
 * A search page is a slice of one ranked list, so a cursor only means anything
 * against the snapshot that produced it. Every mutation that can change which
 * rows a read returns bumps this, and a cursor minted under an older value is
 * refused rather than silently re-run against a list it no longer indexes into.
 */
export function readIndexGeneration(db: SyncDatabase): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_KEY) as
    | { value: string }
    | undefined
  const parsed = row ? Number(row.value) : Number.NaN
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

export function bumpIndexGeneration(db: SyncDatabase): number {
  const next = readIndexGeneration(db) + 1
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(
    GENERATION_KEY,
    String(next)
  )
  return next
}
