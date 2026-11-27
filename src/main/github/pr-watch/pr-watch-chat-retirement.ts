import type { PRWatchServiceDeps } from './pr-watch-types'

const SWEEP_INTERVAL_MS = 60_000
/** Orphans (e.g. an event no chat was owed yet) are rare and take full-table scans to find. */
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000

export class PRChatSweepCadence {
  private lastSweepAt = 0
  private lastOrphanSweepAt = 0

  constructor(private readonly now: () => number) {}

  /** Null while the last sweep is recent; a forced sweep always runs and deletes orphans. */
  due(force: boolean): { deleteOrphans: boolean } | null {
    const now = this.now()
    if (!force && now - this.lastSweepAt < SWEEP_INTERVAL_MS) {
      return null
    }
    this.lastSweepAt = now
    const deleteOrphans = force || now - this.lastOrphanSweepAt >= ORPHAN_SWEEP_INTERVAL_MS
    if (deleteOrphans) {
      this.lastOrphanSweepAt = now
    }
    return { deleteOrphans }
  }
}

export async function sweepGonePRChats(
  deps: PRWatchServiceDeps,
  stopped: () => boolean,
  watches: Iterable<string>,
  forget: (id: string) => void,
  end: (key: string) => Promise<void>,
  options: { deleteOrphans: boolean }
): Promise<void> {
  const chatIds = await deps.database.read({ kind: 'watch-chats' })
  if (stopped()) {
    return
  }
  const gone = chatIds.filter((id) => !deps.chatExists(id))
  // Deleting gone chats also deletes orphans; with none gone, orphans wait for their own cadence.
  if (gone.length === 0 && !options.deleteOrphans) {
    return
  }
  const owned = new Set(await deps.database.write({ kind: 'delete-chats', chatIds: gone }))
  if (stopped()) {
    return
  }
  gone.forEach(forget)
  for (const key of watches) {
    if (!owned.has(key)) {
      await end(key)
    }
  }
}
