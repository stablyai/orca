import { readFile } from 'node:fs/promises'
import type { OrchestrationDb } from './db'
import {
  parseWorkerWatchdogSentinel,
  WORKER_WATCHDOG_CLEANUP_GRACE_MS
} from './worker-watchdog-protocol'

export const WORKER_WATCHDOG_SENTINEL_SETTLE_GRACE_MS = WORKER_WATCHDOG_CLEANUP_GRACE_MS + 2_000

export type WorkerDeadlineReconciliation = {
  dispatchId: string
  action: 'none' | 'settled' | 'stop_unknown'
  reason?: string
  notifyHandle?: string
}

export async function reconcileWorkerDeadlines(
  db: OrchestrationDb,
  deps: {
    now?: () => number
    readFileImpl?: typeof readFile
  } = {}
): Promise<WorkerDeadlineReconciliation[]> {
  const now = deps.now ?? Date.now
  const readFileImpl = deps.readFileImpl ?? readFile
  const results: WorkerDeadlineReconciliation[] = []
  for (const row of db.listActiveBoundedWorkerDeadlines()) {
    const sentinelPath = row.watchdog_sentinel_path
    if (!sentinelPath) {
      continue
    }
    try {
      const sentinel = parseWorkerWatchdogSentinel(
        JSON.parse(await readFileImpl(sentinelPath, 'utf8')) as unknown
      )
      const reconciled = db.reconcileWorkerWatchdogSentinel(row.dispatch_id, sentinel)
      const notifyHandle = reconciled.changed
        ? recordLocalDeadlineMessage(db, row.dispatch_id, reconciled.reason ?? 'worker_stopped')
        : undefined
      results.push({
        dispatchId: row.dispatch_id,
        action: reconciled.changed ? 'settled' : 'none',
        ...(reconciled.reason ? { reason: reconciled.reason } : {}),
        ...(notifyHandle ? { notifyHandle } : {})
      })
      continue
    } catch {
      const deadlineMs = Date.parse(row.deadline_at)
      if (
        !Number.isFinite(deadlineMs) ||
        now() < deadlineMs + WORKER_WATCHDOG_SENTINEL_SETTLE_GRACE_MS
      ) {
        results.push({ dispatchId: row.dispatch_id, action: 'none' })
        continue
      }
      const missing = db.markWorkerDeadlineSentinelMissing(row.dispatch_id)
      const notifyHandle = missing.changed
        ? recordLocalDeadlineMessage(db, row.dispatch_id, 'runtime_budget_stop_unknown')
        : undefined
      results.push({
        dispatchId: row.dispatch_id,
        action: missing.changed ? 'stop_unknown' : 'none',
        ...(missing.changed ? { reason: 'runtime_budget_stop_unknown' } : {}),
        ...(notifyHandle ? { notifyHandle } : {})
      })
    }
  }
  for (const row of db.listActiveRemoteWorkerDeadlines()) {
    const sentinelPath = row.watchdog_sentinel_path
    if (!sentinelPath) {
      continue
    }
    try {
      const sentinel = parseWorkerWatchdogSentinel(
        JSON.parse(await readFileImpl(sentinelPath, 'utf8')) as unknown
      )
      const reconciled = db.reconcileRemoteWorkerWatchdogSentinel(row.dispatch_id, sentinel)
      results.push({
        dispatchId: row.dispatch_id,
        action: reconciled.changed ? 'settled' : 'none',
        ...(reconciled.reason ? { reason: reconciled.reason } : {})
      })
    } catch {
      const deadlineMs = Date.parse(row.deadline_at)
      if (
        !Number.isFinite(deadlineMs) ||
        now() < deadlineMs + WORKER_WATCHDOG_SENTINEL_SETTLE_GRACE_MS
      ) {
        results.push({ dispatchId: row.dispatch_id, action: 'none' })
        continue
      }
      const missing = db.markRemoteWorkerDeadlineSentinelMissing(row.dispatch_id)
      results.push({
        dispatchId: row.dispatch_id,
        action: missing.changed ? 'stop_unknown' : 'none',
        ...(missing.changed ? { reason: 'runtime_budget_stop_unknown' } : {})
      })
    }
  }
  return results
}

function recordLocalDeadlineMessage(
  db: OrchestrationDb,
  dispatchId: string,
  reason: string
): string | undefined {
  const dispatch = db.getDispatchContextById(dispatchId)
  if (!dispatch) {
    return undefined
  }
  const to = `run:${dispatch.run_id}`
  db.insertMessage({
    runId: dispatch.run_id,
    from: `dispatch:${dispatchId}`,
    to,
    subject: `Worker runtime stopped for ${dispatchId}`,
    type: 'status',
    priority: 'high',
    payload: JSON.stringify({ dispatchId, reason })
  })
  return to
}

export class WorkerDeadlineReconciler {
  private timer: NodeJS.Timeout | undefined
  private running = false

  constructor(
    private readonly db: OrchestrationDb,
    private readonly intervalMs = 1_000,
    private readonly onReconciled?: (result: WorkerDeadlineReconciliation) => void
  ) {}

  start(): void {
    if (this.timer) {
      return
    }
    void this.reconcile().catch(() => undefined)
    this.timer = setInterval(() => {
      void this.reconcile().catch(() => undefined)
    }, this.intervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async reconcile(): Promise<WorkerDeadlineReconciliation[]> {
    if (this.running) {
      return []
    }
    this.running = true
    try {
      const results = await reconcileWorkerDeadlines(this.db)
      for (const result of results) {
        this.onReconciled?.(result)
      }
      return results
    } finally {
      this.running = false
    }
  }
}
