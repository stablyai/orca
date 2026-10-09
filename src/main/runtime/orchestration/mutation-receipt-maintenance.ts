import type Database from '../../sqlite/sync-database'

// Same window for both states: a pending fence never outlives the completed replay it stands in for.
const RECEIPT_MAX_AGE = '-30 days'
// Storage bound only; pending receipts are never trimmed by count and nothing is ever refused.
const COMPLETED_RECEIPTS_KEPT = 10_000
const PRUNE_BATCH_SIZE = 256
// Bounds one run's share of the event loop; a larger backlog continues on the next run.
const MAX_BATCHES_PER_RULE = 100

type PruneRule = { sql: string; params: readonly (string | number)[] }

// Literal states so each statement can use its partial index.
export const MUTATION_RECEIPT_PRUNE_RULES: readonly PruneRule[] = [
  {
    sql: `DELETE FROM mutation_receipts
          WHERE rowid IN (
            SELECT rowid FROM mutation_receipts
            WHERE state = 'completed' AND updated_at < datetime('now', ?)
            ORDER BY updated_at ASC, rowid ASC
            LIMIT ?
          )`,
    params: [RECEIPT_MAX_AGE]
  },
  {
    sql: `DELETE FROM mutation_receipts
          WHERE rowid IN (
            SELECT rowid FROM mutation_receipts
            WHERE state = 'pending' AND updated_at < datetime('now', ?)
            ORDER BY updated_at ASC, rowid ASC
            LIMIT ?
          )`,
    params: [RECEIPT_MAX_AGE]
  },
  {
    // Older than the Nth-newest completed receipt; with fewer than N there is no such row.
    sql: `DELETE FROM mutation_receipts
          WHERE rowid IN (
            SELECT rowid FROM mutation_receipts
            WHERE state = 'completed'
              AND (updated_at, rowid) < (
                SELECT updated_at, rowid FROM mutation_receipts
                WHERE state = 'completed'
                ORDER BY updated_at DESC, rowid DESC
                LIMIT 1 OFFSET ?
              )
            ORDER BY updated_at ASC, rowid ASC
            LIMIT ?
          )`,
    params: [COMPLETED_RECEIPTS_KEPT - 1]
  }
]

export type MutationReceiptMaintenance = { stop: () => void }

/**
 * Prunes receipts shortly after the database opens and then periodically. Best effort: a failed
 * run is reported and the next one tries again; no user command waits on it.
 */
export function startMutationReceiptMaintenance(
  db: Database.Database,
  options: {
    initialDelayMs: number
    intervalMs: number
    onError: (error: unknown) => void
  }
): MutationReceiptMaintenance {
  let running = false
  let stopped = false
  const run = (): void => {
    if (running || stopped) {
      return
    }
    running = true
    void pruneMutationReceipts(db, () => stopped)
      .catch(options.onError)
      .finally(() => {
        running = false
      })
  }
  const initial = setTimeout(run, options.initialDelayMs)
  const interval = setInterval(run, options.intervalMs)
  initial.unref?.()
  interval.unref?.()
  return {
    stop: () => {
      stopped = true
      clearTimeout(initial)
      clearInterval(interval)
    }
  }
}

export async function pruneMutationReceipts(
  db: Database.Database,
  isStopped: () => boolean = () => false
): Promise<void> {
  for (const rule of MUTATION_RECEIPT_PRUNE_RULES) {
    for (let batch = 0; batch < MAX_BATCHES_PER_RULE && !isStopped(); batch++) {
      if (deleteReceiptBatch(db, rule) < PRUNE_BATCH_SIZE) {
        break
      }
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
}

function deleteReceiptBatch(db: Database.Database, rule: PruneRule): number {
  const busyTimeout = db.pragma('busy_timeout', { simple: true })
  if (typeof busyTimeout !== 'number' || !Number.isSafeInteger(busyTimeout) || busyTimeout < 0) {
    throw new Error('Invalid SQLite busy timeout')
  }
  // Maintenance yields to another writer instead of parking the runtime's event loop.
  db.pragma('busy_timeout = 0')
  try {
    return Number(db.prepare(rule.sql).run(...rule.params, PRUNE_BATCH_SIZE).changes)
  } finally {
    db.pragma(`busy_timeout = ${busyTimeout}`)
  }
}
