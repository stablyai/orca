import type { RelayDatabase } from './database.js'

// Step 5's after-the-fact record: a reserve-mode cell admits a booked host without reading
// Postgres, and the director that booked it writes the host's relay_assignments row about a
// second later. Phones still resolve through that row until step 6.
//
// A guarded mirror, which nothing reads for a desktop's correctness: only a higher epoch
// replaces a row, and nothing ever lowers one. No relay_cells row and no activity lease is
// touched. A row whose cell changes drops its counters: the leases that back them keep
// their own cell, and unbacked units stay counted on the old cell until its next reconcile,
// which only makes that cell look fuller.

export const RESERVE_LEDGER_FLUSH_MS = 250
export const RESERVE_LEDGER_QUEUE_MAX = 200_000
const RESERVE_LEDGER_BATCH = 500
const RETRY_BASE_MS = 250
const RETRY_MAX_MS = 5_000
const SUMMARY_INTERVAL_MS = 60_000

export type LedgerEntry = {
  userId: string
  relayHostId: string
  cellId: string
  epoch: number
}

export class ReserveLedgerWriter {
  private queue: LedgerEntry[] = []
  private flushing = false
  private failures = 0
  private retryAt = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private dropped = 0
  private written = 0
  private summaryAt: number

  constructor(
    private readonly database: RelayDatabase,
    private readonly input: {
      now?: () => number
      queueMax?: number
      log?: (line: string) => void
    } = {}
  ) {
    this.summaryAt = this.now()
  }

  private now(): number {
    return (this.input.now ?? Date.now)()
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), RESERVE_LEDGER_FLUSH_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  // During a database stall the queue grows; past its bound the oldest entries go first,
  // since the 10-minute reconcile rewrites every seat anyway.
  enqueue(entry: LedgerEntry): void {
    this.queue.push(entry)
    const max = this.input.queueMax ?? RESERVE_LEDGER_QUEUE_MAX
    if (this.queue.length > max) {
      const excess = this.queue.length - max
      this.queue.splice(0, excess)
      this.dropped += excess
    }
  }

  pending(): number {
    return this.queue.length
  }

  // Single-flight; resolves once the queued rows are written or the attempt failed.
  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0 || this.now() < this.retryAt) {
      this.logSummary()
      return
    }
    this.flushing = true
    const batch = this.queue.slice(0, RESERVE_LEDGER_BATCH)
    try {
      await this.write(batch)
      this.queue.splice(0, batch.length)
      this.written += batch.length
      this.failures = 0
      this.retryAt = 0
    } catch {
      this.failures += 1
      this.retryAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.failures - 1))
    } finally {
      this.flushing = false
      this.logSummary()
    }
  }

  private async write(batch: LedgerEntry[]): Promise<void> {
    // The newest entry per host wins inside one batch.
    const latest = new Map<string, LedgerEntry>()
    for (const entry of batch) {
      const key = `${entry.userId}\u0000${entry.relayHostId}`
      const known = latest.get(key)
      if (!known || entry.epoch > known.epoch) latest.set(key, entry)
    }
    await this.upsert([...latest.values()])
  }

  private async upsert(entries: LedgerEntry[]): Promise<void> {
    const now = this.now()
    const rows = entries.map(() => '(?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0)').join(', ')
    const zeroOnMove = (column: string) =>
      `${column} = CASE WHEN relay_assignments.cell_id = excluded.cell_id
         THEN relay_assignments.${column} ELSE 0 END`
    await this.database.query(
      `INSERT INTO relay_assignments
       (user_id, relay_host_id, cell_id, assignment_epoch, lease_expires_at, last_activity_at,
        reserved_controls, reserved_splices, reserved_invites, pending_installs,
        pending_confirmations, migration_leases)
       VALUES ${rows}
       ON CONFLICT (user_id, relay_host_id) DO UPDATE SET
         ${[
           'reserved_controls',
           'reserved_splices',
           'reserved_invites',
           'pending_installs',
           'pending_confirmations',
           'migration_leases'
         ]
           .map(zeroOnMove)
           .join(',\n         ')},
         cell_id = excluded.cell_id,
         assignment_epoch = excluded.assignment_epoch,
         last_activity_at = excluded.last_activity_at
       WHERE relay_assignments.assignment_epoch < excluded.assignment_epoch`,
      entries.flatMap((entry) => [
        entry.userId,
        entry.relayHostId,
        entry.cellId,
        entry.epoch,
        now,
        now
      ])
    )
  }

  // Rows for these hosts, in one read per batch.
  async readRows(
    hosts: ReadonlyArray<{ userId: string; relayHostId: string }>
  ): Promise<Map<string, { cellId: string; epoch: number }>> {
    const rows = new Map<string, { cellId: string; epoch: number }>()
    for (let start = 0; start < hosts.length; start += RESERVE_LEDGER_BATCH) {
      const chunk = hosts.slice(start, start + RESERVE_LEDGER_BATCH)
      const found = await this.database.query(
        `SELECT user_id, relay_host_id, cell_id, assignment_epoch FROM relay_assignments
         WHERE ${chunk.map(() => '(user_id = ? AND relay_host_id = ?)').join(' OR ')}`,
        chunk.flatMap((host) => [host.userId, host.relayHostId])
      )
      for (const row of found) {
        rows.set(`${String(row.user_id)}\u0000${String(row.relay_host_id)}`, {
          cellId: String(row.cell_id),
          epoch: Number(row.assignment_epoch)
        })
      }
    }
    return rows
  }

  private logSummary(): void {
    const now = this.now()
    if (now - this.summaryAt < SUMMARY_INTERVAL_MS) return
    this.summaryAt = now
    ;(this.input.log ?? ((line: string) => console.log(line)))(
      JSON.stringify({
        event: 'orca_relay_reserve_ledger_summary',
        written: this.written,
        pending: this.queue.length,
        dropped: this.dropped,
        failures: this.failures
      })
    )
    this.written = 0
    this.dropped = 0
  }
}

export const RESERVE_LEDGER_RECONCILE_MS = 10 * 60_000
// A seat this young may still be superseded; the next reconcile takes it.
const RECONCILE_SETTLE_MS = 30_000

type ReconcileSeat = { userId: string; relayHostId: string; cellId: string; epoch: number; joinedAt: number }

// Every director upserts the map's seats on reserve-mode cells: guarded and idempotent, so
// concurrent runs are harmless. A row at an equal or higher epoch is left alone.
export async function reconcileReserveLedger(input: {
  writer: ReserveLedgerWriter
  seats: () => ReconcileSeat[]
  now: number
}): Promise<{ upserted: number }> {
  const seats = input.seats().filter((seat) => input.now - seat.joinedAt >= RECONCILE_SETTLE_MS)
  const rows = await input.writer.readRows(seats)
  let upserted = 0
  for (const seat of seats) {
    const row = rows.get(`${seat.userId}\u0000${seat.relayHostId}`)
    if (row && row.epoch >= seat.epoch) continue
    input.writer.enqueue(seat)
    upserted += 1
  }
  return { upserted }
}
