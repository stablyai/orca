import type { OrchestrationDb } from './db'
import type { WorkerScheduledWait } from './db/worker-scheduled-waits'
import { clearWorkerScheduledWait, isWorkerScheduledWaitCurrent } from './db/worker-scheduled-waits'
import { reportWorkerTurnStop, type WorkerTurnStopReportDeps } from './worker-turn-stop-report'

type ScheduledWaitRuntime = {
  getOrchestrationDb: () => OrchestrationDb
  notifyMessageArrived: (handle: string, messageType: string) => void
}

const schedulers = new WeakMap<ScheduledWaitRuntime, WorkerScheduledWaitScheduler>()

export function getWorkerScheduledWaitScheduler(
  runtime: ScheduledWaitRuntime
): WorkerScheduledWaitScheduler {
  let scheduler = schedulers.get(runtime)
  if (!scheduler) {
    scheduler = new WorkerScheduledWaitScheduler(runtime)
    schedulers.set(runtime, scheduler)
  }
  return scheduler
}

export function reportExpiredWorkerWaits(
  db: OrchestrationDb,
  deps: WorkerTurnStopReportDeps
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT returns all columns of the owned worker_scheduled_waits schema.
  const due = db.db
    .prepare('SELECT * FROM worker_scheduled_waits WHERE reported = 0 AND until_ms <= ?')
    .all(Date.now()) as WorkerScheduledWait[]
  for (const wait of due) {
    const dispatch = db.getDispatchContextById(wait.dispatch_id)
    const attachment = db.getRemoteDispatchAttachment(wait.dispatch_id)
    const target =
      dispatch?.status === 'dispatched'
        ? { kind: 'local' as const, dispatch }
        : attachment && ['starting', 'ready', 'start_unknown'].includes(attachment.state)
          ? { kind: 'remote' as const, attachment }
          : undefined
    if (!target || !isWorkerScheduledWaitCurrent(db, wait)) {
      clearWorkerScheduledWait(db, wait.dispatch_id)
      continue
    }
    const reported = reportWorkerTurnStop(
      db,
      target,
      {
        from: wait.from_handle,
        stopKey: `scheduled-wait:${wait.message_id}`,
        reason: 'wait-expired',
        lastOutput: `Scheduled wait expired at ${new Date(wait.until_ms).toISOString()} without progress: ${wait.reason}`
      },
      { ...deps, isWaitingForMail: () => false }
    )
    if (reported) {
      db.db
        .prepare(
          'UPDATE worker_scheduled_waits SET reported = 1 WHERE dispatch_id = ? AND message_id = ?'
        )
        .run(wait.dispatch_id, wait.message_id)
    }
  }
}

export class WorkerScheduledWaitScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly runtime: ScheduledWaitRuntime) {}

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
  }

  rearm(): void {
    this.clear()
    const db = this.runtime.getOrchestrationDb()
    const deadline = db.nextWorkerScheduledWaitAtMs()
    if (deadline === null) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        try {
          reportExpiredWorkerWaits(this.runtime.getOrchestrationDb(), {
            getDb: this.runtime.getOrchestrationDb.bind(this.runtime),
            isWaitingForMail: () => false,
            notify: this.runtime.notifyMessageArrived.bind(this.runtime)
          })
        } catch (error) {
          console.warn('[orchestration] scheduled worker wait expiry failed', error)
        }
        this.rearm()
      },
      Math.min(Math.max(1_000, deadline - Date.now()), 2_147_483_647)
    )
    this.timer.unref?.()
  }
}
