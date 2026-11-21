import type Database from '../../../../sqlite/sync-database'

const waiters = new WeakMap<Database.Database, Set<() => void>>()

/** Wakes every pull waiting on this database; each re-reads its own conversations. Called by every
 *  write that can queue an item home: a reply, a message filed in a Run, a lifecycle change, a reset. */
export function notifyPeerMailQueued(db: Database.Database): void {
  for (const wake of waiters.get(db) ?? []) {
    wake()
  }
}

/** Resolves when an item may have been queued, the wait ends, or the caller goes away. */
export function waitForPeerMail(
  db: Database.Database,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve) => {
    const set = waiters.get(db) ?? new Set<() => void>()
    waiters.set(db, set)
    const done = (): void => {
      clearTimeout(timer)
      set.delete(done)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    set.add(done)
    signal?.addEventListener('abort', done, { once: true })
  })
}
