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
  includeRows = true
): () => void {
  const source = workerDockSession(party)
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
      snapshot: readWorkerDock(db, { party, direction: 'around', includeRows }),
      upgrade: () => {
        held.snapshot = readWorkerDock(db, { party, direction: 'around', includeRows: true })
        seen = db.workerDockSources.version(source)
        publish()
      },
      close: () => {}
    }
    let seen = db.workerDockSources.version(source)
    let unwatchActivity: (() => void) | undefined
    const watchActivity = () => {
      const live = held.snapshot.identities.some(
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
            includeRows: held.detailed
          })
          seen = version
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
    }
    sources.set(party, held)
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
      sources.delete(party)
    } else if (held.detailed && ![...held.listeners.values()].some(Boolean)) {
      held.detailed = false
      held.snapshot = { ...held.snapshot, rows: [] }
    }
  }
}
