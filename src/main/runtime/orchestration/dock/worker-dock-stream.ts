import type { OrchestrationDb } from '../db/orchestration-db'
import { readWorkerDock } from './worker-dock-read'
import type { WorkerDockSnapshot } from '../../../../shared/orchestration/dock/worker-dock'

type Producer = {
  listeners: Set<(value: WorkerDockSnapshot) => void>
  snapshot: WorkerDockSnapshot
  close: () => void
}
const producers = new WeakMap<OrchestrationDb, Map<string, Producer>>()
type ActivitySource = {
  refresh: () => number | null
  subscribe: (wake: () => void) => () => void
}

/** Only visible consumers subscribe; a hidden source has no producer, poll or read. */
export function subscribeWorkerDock(
  db: OrchestrationDb,
  party: string,
  emit: (value: WorkerDockSnapshot) => void,
  activity?: ActivitySource
): () => void {
  let sources = producers.get(db)
  if (!sources) {
    sources = new Map()
    producers.set(db, sources)
  }
  let producer = sources.get(party)
  if (!producer) {
    let expiry: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(expiry)
      const deadline = activity?.refresh()
      if (deadline) {
        expiry = setTimeout(schedule, Math.max(1, deadline - Date.now() + 1))
      }
    }
    refresh()
    const held: Producer = {
      listeners: new Set(),
      snapshot: readWorkerDock(db, { party, direction: 'around' }),
      close: () => {}
    }
    let queued = false
    function schedule() {
      if (queued) {
        return
      }
      queued = true
      queueMicrotask(() => {
        queued = false
        if (!held.listeners.size) {
          return
        }
        try {
          refresh()
          const version = db.db
            .prepare('SELECT revision FROM worker_dock_revision WHERE id = 1')
            .get()
          if (version?.revision === held.snapshot.revision && !held.snapshot.unavailable) {
            return
          }
          const next = readWorkerDock(db, { party, direction: 'around' })
          if (JSON.stringify(next) !== JSON.stringify(held.snapshot)) {
            held.snapshot = next
            for (const listener of held.listeners) {
              listener(next)
            }
          }
        } catch {
          clearTimeout(expiry)
          expiry = setTimeout(schedule, 5000)
          held.snapshot = { ...held.snapshot, unavailable: true }
          for (const listener of held.listeners) {
            listener(held.snapshot)
          }
        }
      })
    }
    const unwatchDb = db.crewChanges.subscribe(schedule)
    const unwatchActivity = activity?.subscribe(schedule)
    held.close = () => {
      unwatchDb()
      unwatchActivity?.()
      clearTimeout(expiry)
    }
    sources.set(party, held)
    producer = held
  }
  const held = producer
  held.listeners.add(emit)
  emit(held.snapshot)
  return () => {
    held.listeners.delete(emit)
    if (!held.listeners.size) {
      held.close()
      sources.delete(party)
    }
  }
}
