import { performance } from 'node:perf_hooks'
import type {
  ControlRenewalOutcome,
  ControlRenewalRequest
} from './control-renewal-statement.js'

// One flush per cell/sec replaces ~10 per-host transactions; missed windows remain within the 105s lease runway.
export const CONTROL_RENEWAL_BATCH_INTERVAL_MS = 1_000
// Bound row locks/parameters: 200 rows measured ~11.5ms on 20k rows and ~9.4ms with one host wedged.
export const CONTROL_RENEWAL_BATCH_MAX_ROWS = 200
// A flush slower than this is the only latency worth a line; the metrics event
// carries the distribution.
const CONTROL_RENEWAL_SLOW_FLUSH_MS = 250

export type ControlRenewalFlush = {
  rows: number
  durationMs: number
  outcomes: Record<string, number>
}

type PendingWaiter = { resolve: () => void; reject: (error: unknown) => void }

type PendingRenewal = { request: ControlRenewalRequest; waiters: PendingWaiter[] }

type QueuedRenewal = { request: ControlRenewalRequest; waiter: PendingWaiter }

// Per host, not per activity: one statement updates a host's assignment row
// once, so two activities for the same host must not share a flush.
function pendingKey(request: ControlRenewalRequest): string {
  return [request.identity.userId, request.identity.relayHostId].join('\u0000')
}

// Preserve per-caller renewal contract: resolve renewed, otherwise reject with its outcome for unchanged session error routing.
export class ControlRenewalBatch {
  private pending = new Map<string, PendingRenewal>()
  // Renewals a host cannot contribute to the flush being built; they open the
  // next one.
  private deferred: QueuedRenewal[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly renew: (
      rows: readonly ControlRenewalRequest[]
    ) => Promise<ControlRenewalOutcome[]>,
    private readonly logFields: () => Record<string, unknown> = () => ({}),
    private readonly observe?: (flush: ControlRenewalFlush) => void
  ) {}

  enqueue(request: ControlRenewalRequest): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.admit({ request, waiter: { resolve, reject } })
    })
  }

  private admit(queued: QueuedRenewal): void {
    const key = pendingKey(queued.request)
    const existing = this.pending.get(key)
    if (existing && existing.request.activityId !== queued.request.activityId) {
      this.deferred.push(queued)
      this.scheduleFlush()
      return
    }
    if (existing) {
      // A second attempt at the same lease inside one window supersedes the
      // first expiry; both callers still hear the outcome they waited for.
      existing.request = {
        ...queued.request,
        expiresAt: Math.max(existing.request.expiresAt, queued.request.expiresAt)
      }
      existing.waiters.push(queued.waiter)
      return
    }
    this.pending.set(key, { request: queued.request, waiters: [queued.waiter] })
    if (this.pending.size >= CONTROL_RENEWAL_BATCH_MAX_ROWS) {
      void this.flush()
      return
    }
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    this.timer ??= setTimeout(() => {
      this.timer = null
      void this.flush()
    }, CONTROL_RENEWAL_BATCH_INTERVAL_MS)
    this.timer.unref?.()
  }

  // Flushes run concurrently on purpose: a statement stalled in PostgreSQL must
  // not hold back the renewals that came due while it was waiting.
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const batch = [...this.pending.values()]
    this.pending = new Map()
    // Re-admitted against the empty map, so a host deferred out of this flush
    // leads the next one.
    const deferred = this.deferred
    this.deferred = []
    for (const queued of deferred) this.admit(queued)
    if (batch.length === 0) return
    const startedAt = performance.now()
    let outcomes: ControlRenewalOutcome[]
    try {
      outcomes = await this.renew(batch.map((entry) => entry.request))
    } catch (error) {
      for (const entry of batch) for (const waiter of entry.waiters) waiter.reject(error)
      this.report(batch.length, performance.now() - startedAt, { flush_failed: batch.length })
      return
    }
    const counts: Record<string, number> = {}
    for (const [index, entry] of batch.entries()) {
      const outcome = outcomes[index] ?? 'database_error'
      counts[outcome] = (counts[outcome] ?? 0) + 1
      for (const waiter of entry.waiters) {
        if (outcome === 'renewed') waiter.resolve()
        else waiter.reject(new Error(outcome))
      }
    }
    this.report(batch.length, performance.now() - startedAt, counts)
  }

  private report(rows: number, durationMs: number, outcomes: Record<string, number>): void {
    this.observe?.({ rows, durationMs, outcomes })
    const renewed = outcomes.renewed ?? 0
    if (durationMs <= CONTROL_RENEWAL_SLOW_FLUSH_MS && renewed === rows) return
    console.warn(
      JSON.stringify({
        event: 'orca_relay_control_renewal_flush',
        ...this.logFields(),
        rows,
        durationMs: Math.round(durationMs),
        outcomes
      })
    )
  }
}
