import type { OrchestrationDb } from '../db/orchestration-db'
import { readWorkerDock, workerDockSession } from './worker-dock-read'
import type { WorkerDockSnapshot } from '../../../../shared/orchestration/dock/worker-dock'
type Producer = {
  listeners: Map<(value: WorkerDockSnapshot) => void, boolean>
  snapshot: WorkerDockSnapshot
  detailed: boolean
  upgrade: () => void
  close: () => void
}
const producers = new WeakMap<OrchestrationDb, Map<string, Producer>>()

type ActivitySource = {
  refresh: () => number | null
  subscribe: (wake: () => void) => () => void
}

/** Visible source consumers share one read; folded consumers request no row details. */
export function subscribeWorkerDock(
  db: OrchestrationDb,
  party: string,
  emit: (value: WorkerDockSnapshot) => void,
  activity?: ActivitySource,
  includeRows = true,
  currentOnly = false
): () => void {
  const source = workerDockSession(party)
  const key = currentOnly ? `current:${party}` : party
  let sources = producers.get(db)
  if (!sources) {
    sources = new Map()
    producers.set(db, sources)
  }
  let producer = sources.get(key)
  if (!producer) {
    let expiry: ReturnType<typeof setTimeout> | undefined
    const refresh = () => {
      clearTimeout(expiry)
      const deadline = activity?.refresh()
      if (deadline) {
        expiry = setTimeout(
          () => {
            activityChanged = true
            schedule()
          },
          Math.max(1, deadline - Date.now() + 1)
        )
      }
    }
    const publish = () => {
      for (const [listener, rows] of held.listeners) {
        listener(rows ? held.snapshot : { ...held.snapshot, rows: [] })
      }
    }
    let activityChanged = false
    refresh()
    const held: Producer = {
      listeners: new Map(),
      detailed: includeRows,
      snapshot: readWorkerDock(db, { party, direction: 'around', includeRows, currentOnly }),
      upgrade: () => {
        held.snapshot = readWorkerDock(db, {
          party,
          direction: 'around',
          includeRows: true,
          currentOnly
        })
        seen = db.workerDockSources.version(source)
        armAging()
        publish()
      },
      close: () => {}
    }
    let seen = db.workerDockSources.version(source)
    // Schedule the nearest expiry so idle sources need no periodic reads.
    let aging: ReturnType<typeof setTimeout> | undefined
    function armAging(snapshot: WorkerDockSnapshot = held.snapshot) {
      clearTimeout(aging)
      const deadline = snapshot.nextExpiry
      if (deadline !== undefined) {
        aging = setTimeout(
          () => {
            db.workerDockSources.invalidate(source, false)
            schedule()
          },
          Math.max(1, deadline - Date.now())
        )
      }
    }
    armAging()
    let unwatchActivity: (() => void) | undefined
    const watchActivity = () => {
      const live =
        held.snapshot.hasUnverifiedWorkers ||
        held.snapshot.identities.some(
          (row) => !['failed', 'unexpected', 'saving'].includes(row.state)
        )
      if (live && !unwatchActivity) {
        unwatchActivity = activity?.subscribe(() => {
          activityChanged = true
          schedule()
        })
      } else if (!live && unwatchActivity) {
        unwatchActivity()
        unwatchActivity = undefined
      }
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
          if (activityChanged) {
            activityChanged = false
            refresh()
          }
          const version = db.workerDockSources.version(source)
          if (version === seen && !held.snapshot.unavailable) {
            return
          }
          const next = readWorkerDock(db, {
            party,
            direction: 'around',
            includeRows: held.detailed,
            currentOnly
          })
          seen = version
          armAging(next)
          if (JSON.stringify(next) !== JSON.stringify(held.snapshot)) {
            held.snapshot = next
            watchActivity()
            publish()
          }
        } catch {
          clearTimeout(expiry)
          expiry = setTimeout(schedule, 5000)
          held.snapshot = { ...held.snapshot, unavailable: true }
          publish()
        }
      })
    }
    const unwatchDb = db.crewChanges.subscribe(() => {
      if (db.workerDockSources.version(source) !== seen) {
        activityChanged = true
        schedule()
      }
    })
    watchActivity()
    held.close = () => {
      unwatchDb()
      unwatchActivity?.()
      clearTimeout(expiry)
      clearTimeout(aging)
    }
    sources.set(key, held)
    producer = held
  }
  const held = producer
  held.listeners.set(emit, includeRows)
  if (includeRows && !held.detailed) {
    held.detailed = true
    held.upgrade()
  } else {
    emit(includeRows ? held.snapshot : { ...held.snapshot, rows: [] })
  }
  return () => {
    held.listeners.delete(emit)
    if (!held.listeners.size) {
      held.close()
      sources.delete(key)
    } else if (held.detailed && ![...held.listeners.values()].some(Boolean)) {
      held.detailed = false
      held.snapshot = { ...held.snapshot, rows: [] }
    }
  }
}
