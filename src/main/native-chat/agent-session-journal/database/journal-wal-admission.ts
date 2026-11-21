import type Database from '../../../sqlite/sync-database'

export const JOURNAL_WAL_BACKPRESSURE_FRAMES = 32_768
/** Send-critical writes pass WAL pressure up to this hard ceiling, so their WAL growth stays bounded. */
export const JOURNAL_WAL_URGENT_FRAMES = 2 * JOURNAL_WAL_BACKPRESSURE_FRAMES

export type JournalWalState = {
  stopped: boolean
  unknown: boolean
  blocked: boolean
  truncating: boolean
  log: number
}

/** Bulk writes wait on WAL pressure; urgent ones wait only for a truncate, an unknown WAL or the ceiling. */
export function journalWalGated(state: JournalWalState, urgent: boolean): boolean {
  if (state.stopped) {
    return false
  }
  if (state.unknown || state.truncating) {
    return true
  }
  return urgent
    ? state.log >= JOURNAL_WAL_URGENT_FRAMES
    : state.blocked || state.log >= JOURNAL_WAL_BACKPRESSURE_FRAMES
}

/** Writers parked on WAL admission, each resumed once its own class is admitted. */
export class JournalWalWaiters {
  private readonly parked = new Set<{ urgent: boolean; resume: () => void }>()

  park(urgent: boolean, resume: () => void): void {
    this.parked.add({ urgent, resume })
  }

  wake(gated: (urgent: boolean) => boolean): void {
    for (const waiter of this.parked) {
      if (!gated(waiter.urgent)) {
        this.parked.delete(waiter)
        waiter.resume()
      }
    }
  }
}

/** The writer's frame-count probe; it needs NOOP checkpoints (SQLite 3.51). */
export function journalWalFrameCounts(
  writer: Database.Database
): ReturnType<Database.Database['prepare']> {
  const version = String(writer.prepare('SELECT sqlite_version() AS version').get()?.version)
  const [major = 0, minor = 0] = version.split('.').map(Number)
  if (major < 3 || (major === 3 && minor < 51)) {
    throw new Error(`SQLite ${version} lacks NOOP checkpoints`)
  }
  return writer.prepare('PRAGMA wal_checkpoint(NOOP)')
}
