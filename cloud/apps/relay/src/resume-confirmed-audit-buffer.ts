import { randomUUID } from 'node:crypto'
import type { RelayDatabase } from './database.js'

// Batch audit writes off confirm’s round trips; unflushed rows are lost on crash/shutdown because exit flushing would race pool closure.
export const RESUME_AUDIT_FLUSH_MS = 5_000
export const RESUME_AUDIT_FLUSH_ROWS = 500
export const RESUME_AUDIT_BUFFER_MAX_ROWS = 5_000
// Drop aged rows rather than reinserting erased accounts’ audit data after an outage.
export const RESUME_AUDIT_MAX_AGE_MS = 10 * 60 * 1000

export type ResumeConfirmedAudit = {
  userId: string
  relayHostId: string
  relayDeviceId: string
  detail: { reqId: string; basisConnId: string; renewed: boolean }
}

// Keep event IDs fixed across unknown commit outcomes so ON CONFLICT prevents duplicate audit rows.
type BufferedRow = ResumeConfirmedAudit & { id: string; at: number }

export type ResumeAuditDrops = { overflow: number; aged: number }

export class ResumeConfirmedAuditBuffer {
  private rows: BufferedRow[] = []
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly dropped: ResumeAuditDrops = { overflow: 0, aged: 0 }
  private reportedDrops = 0
  private stopped = false

  constructor(
    private readonly database: RelayDatabase,
    private readonly now: () => number = Date.now,
    private readonly warn: (line: string) => void = (line) => console.warn(line)
  ) {}

  add(event: ResumeConfirmedAudit): void {
    this.rows.push({ ...event, id: randomUUID(), at: this.now() })
    this.trimToCap()
    if (!this.stopped && !this.timer) {
      this.timer = setInterval(() => void this.flush(), RESUME_AUDIT_FLUSH_MS)
      this.timer.unref?.()
    }
    // Only on crossing the batch size: retries of a failing database wait for the timer.
    if (this.rows.length === RESUME_AUDIT_FLUSH_ROWS) void this.flush()
  }

  // Rows lost since boot: the watcher pages on any.
  drops(): ResumeAuditDrops {
    return { ...this.dropped }
  }

  pending(): number {
    return this.rows.length
  }

  // One flush in flight at a time; a failed batch goes back to the front with its ids.
  async flush(): Promise<void> {
    if (this.flushing) return await this.flushing
    this.flushing = this.flushOnce().finally(() => {
      this.flushing = null
    })
    return await this.flushing
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // The oldest rows go first; rows back from a failed batch count toward the cap.
  private trimToCap(): void {
    const excess = this.rows.length - RESUME_AUDIT_BUFFER_MAX_ROWS
    if (excess <= 0) return
    this.rows.splice(0, excess)
    this.dropped.overflow += excess
  }

  private async flushOnce(): Promise<void> {
    const aged = this.now() - RESUME_AUDIT_MAX_AGE_MS
    const before = this.rows.length
    this.rows = this.rows.filter((row) => row.at > aged)
    this.dropped.aged += before - this.rows.length
    const batch = this.rows.splice(0, RESUME_AUDIT_FLUSH_ROWS)
    if (batch.length > 0) {
      try {
        await this.database.query(
          `INSERT INTO relay_audit_events
           (id, at, type, user_id, relay_host_id, relay_device_id, detail_json)
           VALUES ${batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}
           ON CONFLICT (id) DO NOTHING`,
          batch.flatMap((row) => [
            row.id, row.at, 'resume-confirmed', row.userId, row.relayHostId, row.relayDeviceId,
            JSON.stringify(row.detail)
          ])
        )
      } catch {
        this.rows.unshift(...batch)
        this.trimToCap()
      }
    }
    // At most one line per flush, carrying the totals since boot.
    const total = this.dropped.overflow + this.dropped.aged
    if (total > this.reportedDrops) {
      this.reportedDrops = total
      this.warn(JSON.stringify({ event: 'orca_relay_resume_audit_dropped', ...this.drops() }))
    }
  }
}
