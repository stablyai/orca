import type { OrchestrationDb } from '../../db/orchestration-db'
import { getRuntimeDesktopSurface } from '../../../construction/runtime-desktop-surface'
import { WorkerQuietWatch } from './worker-quiet-watch'
import type { CrewChanges } from '../../crew/crew-changes'
import { WorkerQuietSweep } from './worker-quiet-sweep'
import { reportWorkerQuiet } from './worker-quiet-report'
import { latestWorkerQuietNotices } from './worker-quiet-recovery'
import {
  readQuietWorkers,
  type QuietWorker,
  type QuietWorkerSource
} from './worker-quiet-observations'

export function startWorkerQuietSweep(
  deps: QuietWorkerSource & {
    changes: Pick<CrewChanges, 'subscribe'>
    getMinutes: () => number
    subscribeSettings: (changed: () => void) => () => void
    subscribeTitleStatus?: (wake: () => void) => () => void
    getDb: () => OrchestrationDb | null
    notify: (handle: string, type: string) => void
  }
): () => void {
  const candidates = new Map<string, QuietWorker>()
  let sweep: WorkerQuietSweep | undefined
  let watch: WorkerQuietWatch | undefined
  const createSweep = () =>
    new WorkerQuietSweep(
      Date.now(),
      (ids) => {
        const db = deps.getDb()
        return db
          ? latestWorkerQuietNotices(
              db,
              ids.map((dispatchId) => {
                const target = candidates.get(dispatchId)!.target
                return {
                  dispatchId,
                  runId:
                    target.kind === 'local' ? target.dispatch.run_id : target.attachment.home_run_id
                }
              })
            )
          : new Map()
      },
      (row, notice) => {
        const candidate = candidates.get(row.dispatchId)
        const db = deps.getDb()
        return (
          deps.getMinutes() > 0 &&
          !!db &&
          !!candidate &&
          reportWorkerQuiet(db, candidate.target, { ...row, ...candidate }, notice, deps.notify)
        )
      },
      deps.getMinutes
    )
  const run = (): boolean => {
    if (deps.getMinutes() === 0) {
      return false
    }
    candidates.clear()
    const db = deps.getDb()
    if (!db) {
      return false
    }
    const workers = readQuietWorkers(deps, db)
    for (const worker of workers) {
      candidates.set(worker.observation.dispatchId, worker)
    }
    sweep!.sweep(
      workers.map((worker) => worker.observation),
      Date.now(),
      [...candidates.keys()]
    )
    return workers.some(({ observation }) => observation.connected !== false)
  }
  const createWatch = () =>
    new WorkerQuietWatch({
      sweep: run,
      subscribe: (wake) => {
        const detachTitleStatus = deps.subscribeTitleStatus?.(wake)
        const detachChanges = deps.changes.subscribe((facets) => {
          if (facets.has('topology') || facets.has('status')) {
            wake()
          }
        })
        const detachResume = getRuntimeDesktopSurface().onResume?.(() => {
          sweep!.resume(Date.now())
          wake()
        })
        return () => {
          detachTitleStatus?.()
          detachChanges()
          detachResume?.()
        }
      }
    })
  let enabled = false
  const changed = (): void => {
    const next = deps.getMinutes() > 0
    if (next === enabled) {
      return
    }
    enabled = next
    if (enabled) {
      sweep ??= createSweep()
      sweep.resume(Date.now())
      watch ??= createWatch()
      watch.start()
    } else {
      watch?.pause()
    }
  }
  const detachSettings = deps.subscribeSettings(changed)
  changed()
  return () => {
    detachSettings()
    watch?.pause()
  }
}
