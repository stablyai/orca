// Wakes islands after a handoff relation commits. Mail is stored inside callers' transactions, and a
// lifecycle COMMIT/RELEASE or a bot request's admission notifies nobody after it commits, so the wake
// waits for the outermost transaction itself: one unref'd timer per database, backing off to once a
// second while a transaction stays open (an in-memory check, no SQL), cancelled when the database
// closes or the queue empties. A rolled-back mail is gone by then, so it wakes no one.
import type { OrchestrationDb } from '../db/orchestration-db'
import { backfillWorkerDockDelegations } from './worker-dock-delegations'
import { onStructuredAgentSessionHostChanged } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

const MAX_DELAY_MS = 1000

export class WorkerDockDelegationWake {
  private readonly pending = new Map<string, string>()
  private backfill = false
  private microtask = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private delay = 0
  private closed = false

  constructor(private readonly db: OrchestrationDb) {
    db.onClose(() => this.dispose())
  }

  /** A relation was written with this mail; its sender's island looks again once the mail commits. */
  queue(source: string, messageId: string): void {
    if (this.closed) {
      return
    }
    this.pending.set(messageId, source)
    this.schedule()
  }

  /** Runs the one-time backfill as soon as no transaction is open. */
  requestBackfill(): void {
    if (this.closed) {
      return
    }
    this.backfill = true
    this.schedule()
  }

  get armed(): boolean {
    return this.microtask || this.timer !== undefined
  }

  private schedule(): void {
    if (this.microtask || this.timer !== undefined) {
      return
    }
    this.microtask = true
    queueMicrotask(() => {
      this.microtask = false
      this.flush()
    })
  }

  private flush(): void {
    if (this.closed || (!this.pending.size && !this.backfill)) {
      this.delay = 0
      return
    }
    if (this.db.db.isTransaction) {
      this.delay = Math.min(MAX_DELAY_MS, Math.max(1, this.delay * 2))
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, this.delay)
      this.timer.unref?.()
      return
    }
    this.delay = 0
    const sources = new Set<string>()
    if (this.pending.size) {
      const pending = [...this.pending]
      this.pending.clear()
      const committed = new Set(
        this.db.db
          .prepare(
            'SELECT m.id FROM json_each(?) selected JOIN messages m ON m.id = selected.value'
          )
          .all(JSON.stringify(pending.map(([id]) => id)))
          .map((row) => String(row.id))
      )
      for (const [id, source] of pending) {
        if (committed.has(id)) {
          sources.add(source)
        }
      }
    }
    if (this.backfill) {
      const backfilled = backfillWorkerDockDelegations(this.db)
      // Not run while the session lineage is still loading: the host hook asks again.
      this.backfill = false
      for (const source of backfilled ?? []) {
        sources.add(source)
      }
    }
    for (const source of sources) {
      this.db.workerDockSources.invalidate(source)
    }
    if (sources.size) {
      this.db.crewChanges.notify(new Set(['topology']))
    }
  }

  private dispose(): void {
    this.closed = true
    this.pending.clear()
    this.backfill = false
    clearTimeout(this.timer)
    this.timer = undefined
  }
}

const wakes = new WeakMap<OrchestrationDb, WorkerDockDelegationWake>()

export function workerDockDelegationWake(db: OrchestrationDb): WorkerDockDelegationWake {
  let wake = wakes.get(db)
  if (!wake) {
    wake = new WorkerDockDelegationWake(db)
    wakes.set(db, wake)
  }
  return wake
}

/** Runs the backfill now and again whenever the session host (and with it the chats' lineage) is
 *  installed; the watch ends with the database. Returns its disposer. */
export function watchWorkerDockBackfillHost(db: OrchestrationDb): () => void {
  const backfill = () => workerDockDelegationWake(db).requestBackfill()
  const unwatchHost = onStructuredAgentSessionHostChanged(backfill)
  const unwatchClose = db.onClose(() => unwatchHost())
  backfill()
  return () => {
    unwatchHost()
    unwatchClose()
  }
}
