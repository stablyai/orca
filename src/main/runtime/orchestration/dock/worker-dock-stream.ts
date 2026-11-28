import type { OrchestrationDb } from '../db/orchestration-db'
import { readWorkerDock, workerDockSession, type WorkerDockReadOptions } from './worker-dock-read'
import type { WorkerDockSnapshot } from '../../../../shared/orchestration/dock/worker-dock'
import { sessionCrewChanges } from '../crew/crew-changes'
import type { WorkerDockElsewhereActivitySource } from './worker-dock-elsewhere-activity'
import { workerDockElsewhereSignature, type WorkerDockElsewhereRead } from './worker-dock-elsewhere'
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

const MAX_RETRY_MS = 1000

function committedRevision(db: OrchestrationDb): number {
  const row = db.db.prepare('SELECT revision FROM worker_dock_revision WHERE id = 1').get()
  return typeof row?.revision === 'number' ? row.revision : 0
}

/** Whether a snapshot shows, or keeps watching for, Other chats rows. */
function watchesElsewhere(snapshot: WorkerDockSnapshot): boolean {
  return Boolean(
    snapshot.elsewhere?.length || snapshot.relations || snapshot.hasUnverifiedElsewhere
  )
}

/** Visible source consumers share one read; folded consumers request no row details. */
export function subscribeWorkerDock(
  db: OrchestrationDb,
  party: string,
  emit: (value: WorkerDockSnapshot) => void,
  activity?: ActivitySource,
  includeRows = true,
  currentOnly = false,
  elsewhereActivity?: WorkerDockElsewhereActivitySource
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
    let elsewhereExpiry: ReturnType<typeof setTimeout> | undefined
    // Other chats rows: what the last read counted, and what makes them worth reading again.
    let elsewhere: WorkerDockElsewhereRead | undefined
    let elsewhereDirty = false
    let globalDirty = false
    let dbClosed = false
    let baseline = committedRevision(db)
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
    const readOptions: WorkerDockReadOptions = {
      refreshElsewhere: elsewhereActivity
        ? (ready) => {
            clearTimeout(elsewhereExpiry)
            const deadline = elsewhereActivity.refresh(ready)
            if (deadline) {
              elsewhereExpiry = setTimeout(
                () => {
                  elsewhereDirty = true
                  schedule()
                },
                Math.max(1, deadline - Date.now() + 1)
              )
            }
          }
        : undefined,
      onElsewhere: (read) => {
        elsewhere = read
      }
    }
    const read = (rows: boolean) => {
      // Read with no transaction open, so the baseline is committed data.
      baseline = committedRevision(db)
      return readWorkerDock(
        db,
        { party, direction: 'around', includeRows: rows, currentOnly },
        readOptions
      )
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
      snapshot: read(includeRows),
      upgrade: () => {
        held.snapshot = read(true)
        seen = db.workerDockSources.version(source)
        armAging()
        watchActivity()
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
    let unwatchElsewhere: (() => void) | undefined
    const watchActivity = () => {
      const live =
        held.snapshot.hasUnverifiedWorkers ||
        held.snapshot.identities.some(
          // An unsettled stopped row is an exited worker whose chat can be continued.
          (row) =>
            !['failed', 'unexpected', 'saving'].includes(row.state) ||
            (row.state === 'unexpected' && !row.settlement)
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
      // Other chats' counted workers (aged-out ones too, so a recovery shows) and their chats' names.
      const watching = watchesElsewhere(held.snapshot)
      if (watching && !unwatchElsewhere) {
        const wake = () => {
          elsewhereDirty = true
          schedule()
        }
        const panes = elsewhereActivity?.subscribe(wake)
        const records = sessionCrewChanges.subscribe((facets) => {
          // A store or host change names no record: the rows' names may all have changed.
          if (
            elsewhere?.elsewhere.length &&
            (!facets.recordIds || facets.recordIds.some((id) => elsewhere?.sessions.has(id)))
          ) {
            wake()
          }
        })
        unwatchElsewhere = () => {
          panes?.()
          records()
        }
      } else if (!watching && unwatchElsewhere) {
        unwatchElsewhere()
        unwatchElsewhere = undefined
      }
    }
    let queued = false
    let retry: ReturnType<typeof setTimeout> | undefined
    let retryDelay = 0
    function schedule() {
      if (queued || retry !== undefined) {
        return
      }
      queued = true
      queueMicrotask(run)
    }
    function run() {
      queued = false
      // A timer that outlived the database (compaction closes it) must not touch it.
      if (!held.listeners.size || dbClosed) {
        return
      }
      // Never read inside a transaction: it may roll back. One unref'd timer, at most once a second.
      if (db.db.isTransaction) {
        retryDelay = Math.min(MAX_RETRY_MS, Math.max(1, retryDelay * 2))
        retry = setTimeout(() => {
          retry = undefined
          run()
        }, retryDelay)
        retry.unref?.()
        return
      }
      retryDelay = 0
      try {
        if (activityChanged) {
          activityChanged = false
          refresh()
        }
        const version = db.workerDockSources.version(source)
        let full = version !== seen || elsewhereDirty || Boolean(held.snapshot.unavailable)
        if (!full && globalDirty) {
          // Some worker changed somewhere: read again only if this chat's Other chats rows did.
          globalDirty = false
          const revision = committedRevision(db)
          if (revision !== baseline) {
            baseline = revision
            full = workerDockElsewhereSignature(db, source) !== (elsewhere?.signature ?? '[]')
          }
        }
        if (!full) {
          return
        }
        elsewhereDirty = false
        globalDirty = false
        const next = read(held.detailed)
        seen = version
        armAging(next)
        if (JSON.stringify(next) !== JSON.stringify(held.snapshot)) {
          held.snapshot = next
          publish()
        }
        watchActivity()
      } catch {
        clearTimeout(expiry)
        expiry = setTimeout(schedule, 5000)
        held.snapshot = { ...held.snapshot, unavailable: true }
        publish()
      }
    }
    // No SQL here: notices come from inside transactions that may still roll back.
    const unwatchDb = db.crewChanges.subscribe(() => {
      if (db.workerDockSources.version(source) !== seen) {
        activityChanged = true
        schedule()
      } else if (watchesElsewhere(held.snapshot)) {
        globalDirty = true
        schedule()
      }
    })
    watchActivity()
    const unwatchClose = db.onClose(() => {
      dbClosed = true
      held.close()
      producers.get(db)?.delete(key)
    })
    held.close = () => {
      unwatchClose()
      unwatchDb()
      unwatchActivity?.()
      unwatchElsewhere?.()
      clearTimeout(expiry)
      clearTimeout(elsewhereExpiry)
      clearTimeout(aging)
      clearTimeout(retry)
      retry = undefined
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
