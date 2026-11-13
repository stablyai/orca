// Evacuation sweep: a desktop connected to the relay edge only asks the director again when its
// lease ends, so a host that left the edge cohort would stay there for hours. The sweep finds edge
// rows whose host is no longer in the cohort and asks the edge to drain them; the desktop then
// re-asks /v1/assign, and that ask exports its data and places it on a cell (app.ts). Each pass also
// retries fences that did not land after a host left (edge-relay-fence.ts).
import { RelayRegionSchema, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { RelayDatabase, SqlRow } from './database.js'
import { EdgeAdminUnavailableError, type EdgeAdmin } from './edge-admin-client.js'
import { inEdgeCohort, mayBeOnEdge, type EdgeRelayConfig } from './edge-relay.js'
import { EDGE_CONTROL_DEFAULTS, edgeRegionalRollout } from './edge-relay-control.js'
import { forEachBounded, retryPendingFences } from './edge-relay-fence.js'

type Identity = { userId: string; relayHostId: string }

function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') { throw new Error(`invalid_${field}`) }
  return value
}

// A cohort change (director/edge.json, or a new revision) re-arms the sweep (controlChanged), so a
// soon pass and then a slow background pass are enough; each pass reads the edge rows (cell_id has
// no index).
export const EDGE_EVACUATION_INTERVAL_MS = 10 * 60_000
// First pass after start, and the next pass while more leaving hosts are queued.
export const EDGE_EVACUATION_BUSY_INTERVAL_MS = 60_000
// Longest wait for a pass after the runtime control changes, so a rollback starts at once.
export const EDGE_EVACUATION_CONTROL_DELAY_MS = 5_000
// Drains sent per tick (per director): a full rollback of ~19k hosts over 5 directors takes ~40 min.
export const EDGE_EVACUATION_BATCH = 100
// Drains in flight at once per director.
export const EDGE_EVACUATION_CONCURRENCY = 10
// Edge rows read per page; the cursor walks the table across ticks.
const EDGE_EVACUATION_PAGE = 500
// A host this director drained is not drained again for this long (a desktop that is offline
// answers idle, and asks the director on its own when it comes back).
const EDGE_EVACUATION_COOLDOWN_MS = 10 * 60_000
// A pass starts at a random point of the key space and wraps around to it, so directors sweeping
// at once mostly drain different hosts.
type Pass = { origin: Identity; cursor: Identity; wrapped: boolean }

export class EdgeEvacuation {
  // Undefined between passes.
  private pass: Pass | undefined
  private readonly drainedAt = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private busy = true
  private sweeping = false
  private controlChangedWhileSweeping = false

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

  // The runtime control changed (e.g. mode off for a rollback): the next pass runs within
  // EDGE_EVACUATION_CONTROL_DELAY_MS instead of waiting out the idle interval.
  controlChanged(): void {
    this.busy = true
    if (this.stopped) { return }
    if (this.sweeping) {
      this.controlChangedWhileSweeping = true
      return
    }
    clearTimeout(this.timer)
    this.schedule(EDGE_EVACUATION_CONTROL_DELAY_MS * this.random())
  }

  // One tick: returns how many drains the edge answered.
  async sweep(): Promise<number> {
    const now = this.now()
    for (const [key, sentAt] of this.drainedAt) {
      if (now - sentAt >= EDGE_EVACUATION_COOLDOWN_MS) { this.drainedAt.delete(key) }
    }
    const leaving = await this.leavingHosts()
    this.busy = leaving.length >= EDGE_EVACUATION_BATCH || this.pass !== undefined
    let answered = 0
    await forEachBounded(leaving, EDGE_EVACUATION_CONCURRENCY, async (identity) => {
      try {
        const result = await this.admin.drain(identity.relayHostId)
        this.drainedAt.set(drainKey(identity), this.now())
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
    })
    // Pending fences keep the busy cadence, so their backoff (from 60 s) is honoured.
    if (await retryPendingFences(this.database, this.admin, this.edgeCellId, this.now)) { this.busy = true }
    return answered
  }

  // Edge rows (a page after the cursor; a second when the first ends the pass's first half) whose
  // host left the cohort, skipping recent drains. An idle pass reads each edge row once.
  private async leavingHosts(): Promise<Identity[]> {
    const leaving: Identity[] = []
    this.pass ??= this.newPass()
    const regional = edgeRegionalRollout(this.config.control?.() ?? EDGE_CONTROL_DEFAULTS)
    for (let pages = 0; pages < 2 && this.pass !== undefined; pages += 1) {
      const pass: Pass = this.pass
      const rows = await this.readPage(pass, regional)
      let filled = false
      for (const row of rows) {
        const identity = { userId: text(row, 'user_id'), relayHostId: text(row, 'relay_host_id') }
        pass.cursor = identity
        // Region scope is the assign path's call: it decides with the region the desktop asks for.
        // Without regional shares the sweep judges 'any' (the cell path's stored preference can
        // lag: judging it drained hosts that the next ask put straight back). With them, a host
        // is judged by the effective share of the region its last edge ask recorded
        // (relay_edge_host_regions), so a regional abort or shrink drains just that region; a
        // host with no record is judged 'any'. Country exclusion needs the ask's address, so an
        // excluded host leaves on its next ask.
        const region = regional ? recordedRegion(row) : 'any'
        if (inEdgeCohort(this.config, identity.relayHostId, region, identity.userId)) { continue }
        if (!mayBeOnEdge(this.config, identity.relayHostId, identity.userId)) {
          // leaveCeilingPermille is set below a rollout this host was moved under: its asks skip
          // the leave read, so it would be re-placed without its devices. Raise the ceiling.
          console.error(JSON.stringify({ event: 'orca_relay_edge_row_above_ceiling' }))
        }
        if (this.drainedAt.has(drainKey(identity))) { continue }
        leaving.push(identity)
        // Resume after the last host taken, so the rest of the page is read next tick.
        if (leaving.length === EDGE_EVACUATION_BATCH) {
          filled = true
          break
        }
      }
      if (filled || rows.length === EDGE_EVACUATION_PAGE) { break }
      // A short page ends this half: wrap to the start of the keys, or end the pass.
      if (pass.wrapped) {
        this.pass = undefined
      } else {
        pass.wrapped = true
        pass.cursor = { userId: '', relayHostId: '' }
      }
    }
    return leaving
  }

  // Keys after the cursor; once wrapped, only up to the pass's origin. `regional`: with the region
  // the host's last edge ask recorded (primary key join; none: NULL).
  private async readPage(pass: Pass, regional: boolean) {
    const { cursor, origin, wrapped } = pass
    return await this.database.query(
      `SELECT a.user_id, a.relay_host_id${regional ? ', r.region' : ''}
       FROM relay_assignments a${
         regional
           ? `
       LEFT JOIN relay_edge_host_regions r
         ON r.user_id = a.user_id AND r.relay_host_id = a.relay_host_id`
           : ''
       }
       WHERE a.cell_id = ? AND (a.user_id > ? OR (a.user_id = ? AND a.relay_host_id > ?))
         ${wrapped ? 'AND (a.user_id < ? OR (a.user_id = ? AND a.relay_host_id <= ?))' : ''}
       ORDER BY a.user_id, a.relay_host_id
       LIMIT ?`,
      [
        this.edgeCellId,
        cursor.userId,
        cursor.userId,
        cursor.relayHostId,
        ...(wrapped ? [origin.userId, origin.userId, origin.relayHostId] : []),
        EDGE_EVACUATION_PAGE
      ]
    )
  }

  // Account ids are UUIDs, so a random hex prefix lands anywhere in the key space; ids of another
  // shape are still all swept, from a less spread origin.
  private newPass(): Pass {
    const prefix = Math.floor(this.random() * 0x1_0000_0000).toString(16).padStart(8, '0')
    const origin = { userId: prefix, relayHostId: '' }
    return { origin, cursor: origin, wrapped: false }
  }

  private schedule(delayMs?: number): void {
    if (this.stopped) { return }
    // Jittered (±25%), so directors do not sweep together.
    const interval = this.busy ? EDGE_EVACUATION_BUSY_INTERVAL_MS : EDGE_EVACUATION_INTERVAL_MS
    const delay = delayMs ?? interval * (0.75 + this.random() / 2)
    this.timer = setTimeout(() => {
      this.sweeping = true
      void this.sweep()
        .catch((error: unknown) =>
          console.warn(
            JSON.stringify({
              event: 'orca_relay_edge_evacuation_deferred',
              reason: error instanceof Error ? error.message : 'unknown'
            })
          )
        )
        .finally(() => {
          this.sweeping = false
          const changed = this.controlChangedWhileSweeping
          this.controlChangedWhileSweeping = false
          this.schedule(changed ? EDGE_EVACUATION_CONTROL_DELAY_MS * this.random() : undefined)
        })
    }, delay)
    this.timer.unref?.()
  }
}

function recordedRegion(row: SqlRow): RelayRegion | 'any' {
  const recorded = RelayRegionSchema.safeParse(row.region)
  return recorded.success ? recorded.data : 'any'
}

function drainKey(identity: Identity): string {
  return `${identity.userId}\n${identity.relayHostId}`
}
