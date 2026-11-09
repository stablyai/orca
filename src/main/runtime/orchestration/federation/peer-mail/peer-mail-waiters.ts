import type { OrchestrationDb } from '../../db/orchestration-db'

const waiters = new WeakMap<OrchestrationDb, Set<() => void>>()

/** Wakes every pull waiting on this store; each re-reads its own conversations. */
export function notifyPeerMailQueued(db: OrchestrationDb): void {
  for (const wake of waiters.get(db) ?? []) {
    wake()
  }
}

/** Resolves when a reply is queued, the wait ends, or the caller goes away. */
export function waitForPeerMail(
  db: OrchestrationDb,
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
