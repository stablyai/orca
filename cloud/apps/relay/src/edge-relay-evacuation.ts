// Evacuation sweep: a desktop connected to the relay edge only asks the director again when its
// lease ends, so a host that left the edge cohort would stay there for hours. The sweep finds edge
// rows whose host is no longer in the cohort and asks the edge to drain them; the desktop then
// re-asks /v1/assign, and that ask exports its data and places it on a cell (app.ts).
import { RELAY_DEFAULT_REGION, RelayRegionSchema } from '@orca-cloud/relay-contract/relay-regions'
import type { RelayDatabase, SqlRow } from './database.js'
import { EdgeAdminUnavailableError, type EdgeAdmin } from './edge-admin-client.js'
import { inEdgeCohort, type EdgeRelayConfig } from './edge-relay.js'

type Identity = { userId: string; relayHostId: string }

function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') { throw new Error(`invalid_${field}`) }
  return value
}

export const EDGE_EVACUATION_INTERVAL_MS = 60_000
// Drains sent per tick (per director), so a cohort cut moves desktops back gradually.
export const EDGE_EVACUATION_BATCH = 20
// Edge rows read per tick; the cursor walks the table across ticks.
const EDGE_EVACUATION_PAGE = 500
// A host this director drained is not drained again for this long (a desktop that is offline
// answers idle, and asks the director on its own when it comes back).
const EDGE_EVACUATION_COOLDOWN_MS = 10 * 60_000

export class EdgeEvacuation {
  private cursor: Identity | undefined
  private readonly drainedAt = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true

  constructor(
    private readonly database: RelayDatabase,
    private readonly config: EdgeRelayConfig,
    private readonly admin: EdgeAdmin,
    private readonly edgeCellId: string,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {}

  start(): void {
    this.stopped = false
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = undefined
  }

  // One tick: returns how many drains the edge answered.
  async sweep(): Promise<number> {
    const now = this.now()
    for (const [key, sentAt] of this.drainedAt) {
      if (now - sentAt >= EDGE_EVACUATION_COOLDOWN_MS) { this.drainedAt.delete(key) }
    }
    const leaving = await this.leavingHosts()
    let answered = 0
    for (const identity of leaving) {
      try {
        const result = await this.admin.drain(identity.relayHostId)
        this.drainedAt.set(`${identity.userId}\n${identity.relayHostId}`, this.now())
        answered += 1
        console.warn(
          JSON.stringify({
            event: 'orca_relay_edge_drain_sent',
            outcome: result.outcome,
            ...(result.outcome === 'drained' ? { controls: result.controls } : {})
          })
        )
      } catch (error) {
        if (!(error instanceof EdgeAdminUnavailableError)) { throw error }
        console.warn(JSON.stringify({ event: 'orca_relay_edge_drain_failed', reason: error.message }))
      }
    }
    return answered
  }

  // Edge rows (one page after the cursor) whose host left the cohort, skipping recent drains.
  private async leavingHosts(): Promise<Identity[]> {
    const cursor = this.cursor ?? { userId: '', relayHostId: '' }
    const rows = await this.database.query(
      `SELECT a.user_id, a.relay_host_id, p.preferred_region
       FROM relay_assignments a
       LEFT JOIN relay_assignment_region_preferences p
         ON p.user_id = a.user_id AND p.relay_host_id = a.relay_host_id
       WHERE a.cell_id = ? AND (a.user_id > ? OR (a.user_id = ? AND a.relay_host_id > ?))
       ORDER BY a.user_id, a.relay_host_id
       LIMIT ?`,
      [this.edgeCellId, cursor.userId, cursor.userId, cursor.relayHostId, EDGE_EVACUATION_PAGE]
    )
    // A short page reached the end: the next tick starts over.
    this.cursor = undefined
    const leaving: Identity[] = []
    for (const [index, row] of rows.entries()) {
      const identity = { userId: text(row, 'user_id'), relayHostId: text(row, 'relay_host_id') }
      if (rows.length === EDGE_EVACUATION_PAGE && index === rows.length - 1) { this.cursor = identity }
      const stored = RelayRegionSchema.safeParse(row.preferred_region)
      const region = stored.success ? stored.data : RELAY_DEFAULT_REGION
      if (inEdgeCohort(this.config, identity.relayHostId, region, identity.userId)) { continue }
      if (this.drainedAt.has(`${identity.userId}\n${identity.relayHostId}`)) { continue }
      leaving.push(identity)
      if (leaving.length === EDGE_EVACUATION_BATCH) {
        // Resume after the last host taken, so the rest of the page is read next tick.
        this.cursor = identity
        break
      }
    }
    return leaving
  }

  private schedule(): void {
    if (this.stopped) { return }
    // Jittered (45-75 s), so directors do not sweep together.
    const delay = EDGE_EVACUATION_INTERVAL_MS * (0.75 + this.random() / 2)
    this.timer = setTimeout(() => {
      void this.sweep()
        .catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              event: 'orca_relay_edge_evacuation_deferred',
              reason: error instanceof Error ? error.message : 'unknown'
            })
          )
        )
        .finally(() => this.schedule())
    }, delay)
    this.timer.unref?.()
  }
}
