import type { Hono } from 'hono'
import type { CellFlags } from './cell-flags.js'
import type { CellSeatFeedPage } from './cell-seat-log.js'
import { parseCellSeatCursor } from './cell-seat-log.js'
import type { RelayConfig } from './config.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'
import type { RelayRuntimeCounts } from './relay-observability.js'
import { readBearer } from './relay-token-verifier.js'

// Read-only, so it reuses the directors' rehome credential and grants it nothing new. Only
// cells that already hold the rehome pair serve it: giving a cell the pair turns rehome on.
export function registerCellSeatFeedRoute(
  app: Hono,
  config: RelayConfig,
  input: {
    verifyRegionalRehomeToken: (token: string) => Promise<boolean>
    cellIncarnation?: string
    seatFeed?: (sinceSeq: number | null) => CellSeatFeedPage
    isDraining?: () => boolean
    runtimeCounts?: () => RelayRuntimeCounts
    cellFlags?: () => AppliedControlFlags<CellFlags>
    // A placing director's poll (reserver=1) feeds the cell's dead-man.
    onReserverPoll?: () => void
    admitModeEffective?: () => 'db' | 'reserve'
    // Step 5: what a director needs to estimate a seat and a booking here.
    reserveCounts?: () => {
      bookings: number
      intake: { perSec: number; burst: number; tokens: number }
    } | null
    placementCeiling?: number
    now?: () => number
  }
): void {
  app.get('/v1/admin/cell-seats', async (context) => {
    if (config.role !== 'cell' || !input.seatFeed || !input.cellIncarnation) {
      return context.json({ error: 'cell_only' }, 404)
    }
    if (!config.rehomeAudience || !config.rehomeDirectorServiceAccount) {
      return context.json({ error: 'seat_feed_unavailable' }, 404)
    }
    const bearer = readBearer(context.req.header('authorization'))
    if (!bearer || !(await input.verifyRegionalRehomeToken(bearer))) {
      return context.json({ error: 'invalid_token' }, 401)
    }
    if (context.req.query('reserver') === '1') input.onReserverPoll?.()
    const cursor = parseCellSeatCursor(context.req.query('since'))
    if (cursor === 'invalid') return context.json({ error: 'invalid_request' }, 400)
    const sinceSeq =
      cursor !== null && cursor.incarnation === input.cellIncarnation ? cursor.seq : null
    const { seats, ...page } = input.seatFeed(sinceSeq)
    const counts = input.runtimeCounts?.()
    const reserve = input.reserveCounts?.() ?? null
    return context.json({
      v: 1,
      cellId: config.cellId,
      incarnation: input.cellIncarnation,
      at: (input.now ?? Date.now)(),
      draining: input.isDraining?.() ?? false,
      counts: {
        controls: counts?.controls ?? 0,
        // The feed's own view: a reader that applied every change holds exactly this many.
        // `controls` drops when a socket starts closing, `seats` when its close lands.
        seats,
        ...(reserve && input.placementCeiling !== undefined
          ? {
              bookings: reserve.bookings,
              // Every unit the ledger counts against the ceiling, bookings and phones included.
              units: counts?.enforcedConnectionUnits ?? 0,
              ceiling: input.placementCeiling
            }
          : {})
      },
      ...(reserve ? { intake: reserve.intake } : {}),
      // Applied, never desired: generation 0 means no object has been read since boot.
      ...(input.cellFlags ? { flagsApplied: input.cellFlags() } : {}),
      ...(input.admitModeEffective ? { admitModeEffective: input.admitModeEffective() } : {}),
      ...page
    })
  })
}
