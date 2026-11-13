import type { OrchestrationDb } from '../db/orchestration-db'
import type { RunPartyLiveness } from '../db/retention/orchestration-retention'

export const ORCHESTRATION_RUN_RETENTION_HOURS_DEFAULT = 24
const FIRST_SWEEP_DELAY_MS = 60_000
const SWEEP_INTERVAL_MS = 60 * 60_000
const RUN_CANDIDATES_PER_PAGE = 256
const ROWS_PER_TRANSACTION = 256

export type OrchestrationRetentionRuntime = {
  getOrchestrationDb(): OrchestrationDb
  getOrchestrationRunRetentionHours(): number
  isLiveOrchestrationHandle(handle: string): boolean
  hasLiveTerminalForPaneKey(paneKey: string): boolean
}

const schedulerByRuntime = new WeakMap<
  OrchestrationRetentionRuntime,
  OrchestrationRetentionScheduler
>()

// Keyed by runtime, not a field: the database can open while the runtime is still constructing.
export function getOrchestrationRetentionScheduler(
  runtime: OrchestrationRetentionRuntime
): OrchestrationRetentionScheduler {
  let scheduler = schedulerByRuntime.get(runtime)
  if (!scheduler) {
    scheduler = new OrchestrationRetentionScheduler(runtime)
    schedulerByRuntime.set(runtime, scheduler)
  }
  return scheduler
}

export function resolveOrchestrationRunRetentionHours(setting: number | undefined): number {
  return typeof setting === 'number' && Number.isFinite(setting) && setting >= 0
    ? setting
    : ORCHESTRATION_RUN_RETENTION_HOURS_DEFAULT
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export class OrchestrationRetentionScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly runtime: OrchestrationRetentionRuntime) {}

  start(): void {
    if (!this.timer) {
      this.schedule(FIRST_SWEEP_DELAY_MS)
    }
  }

  async sweep(): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    let receipts = { lastRowid: 0, read: 0 }
    do {
      receipts = db.compactMutationReceipts(receipts.lastRowid, ROWS_PER_TRANSACTION)
      await yieldToEventLoop()
    } while (receipts.read === ROWS_PER_TRANSACTION && this.runtime.getOrchestrationDb() === db)
    const retentionHours = this.runtime.getOrchestrationRunRetentionHours()
    if (retentionHours === 0) {
      return
    }
    const liveness: RunPartyLiveness = {
      isLiveHandle: (handle) => this.runtime.isLiveOrchestrationHandle(handle),
      isLivePane: (paneKey) => this.runtime.hasLiveTerminalForPaneKey(paneKey)
    }
    let page: string[] = []
    do {
      page = db.listRetiredRunCandidates(retentionHours, page.at(-1) ?? '', RUN_CANDIDATES_PER_PAGE)
      for (const runId of page) {
        if (this.runtime.getOrchestrationDb() !== db) {
          return
        }
        db.deleteRetiredRun(runId, retentionHours, liveness)
        await yieldToEventLoop()
      }
    } while (page.length === RUN_CANDIDATES_PER_PAGE)
    while (
      this.runtime.getOrchestrationDb() === db &&
      db.deleteExpiredOrchestrationRows(retentionHours, ROWS_PER_TRANSACTION) > 0
    ) {
      await yieldToEventLoop()
    }
  }

  private schedule(delayMs: number): void {
    const timer = setTimeout(() => {
      void this.sweep()
        .catch((error: unknown) => {
          console.warn('[orchestration] retention sweep failed', {
            error: error instanceof Error ? error.message : String(error)
          })
        })
        .finally(() => this.schedule(SWEEP_INTERVAL_MS))
    }, delayMs)
    timer.unref?.()
    this.timer = timer
  }
}
