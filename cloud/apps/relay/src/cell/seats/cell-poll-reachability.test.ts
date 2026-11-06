import { describe, expect, it, vi } from 'vitest'
import { CELL_POLL_DEAD_STREAK_MS, CellPollReachability, type PolledCell } from './cell-poll-reachability.js'
import { startShadowSeatPoller, type SeatFeedCell } from './shadow-seat-directory.js'

// Production's shape: 28 US cells and 6 in Asia.
const FLEET: PolledCell[] = [
  ...Array.from({ length: 28 }, (_, index) => ({ cellId: `us${index}`, region: 'us-central1' })),
  ...Array.from({ length: 6 }, (_, index) => ({ cellId: `asia${index}`, region: 'asia-east2' }))
]

describe('CellPollReachability', () => {

  it('a staggered partition never judges its first cell dead: young streaks count as failing', () => {
    const reach = new CellPollReachability()
    // Six Asia cells cut off at 0-2 s offsets, each polled once a second for two minutes.
    const offsets = [0, 400, 800, 1_200, 1_600, 2_000]
    for (let at = 0; at <= 120_000; at += 100) {
      offsets.forEach((offset, index) => {
        if (at >= offset && (at - offset) % 1_000 === 0) reach.unanswered(`asia${index}`, at)
      })
      for (let index = 0; index < 6; index += 1) {
        expect(reach.verdict(`asia${index}`, FLEET, at)?.dead ?? false).toBe(false)
      }
    }
  })

})

const INCARNATION = '11111111-1111-4111-8111-111111111111'

const feedCell = (cellId: string): SeatFeedCell => ({
  cellId,
  cellUrl: `https://${cellId}.example.test`,
  region: 'us-central1',
  heartbeatExpiresAt: 2_000_000_000_000,
  requiredForComplete: true,
  capacityRequests: 10
})
const CELLS = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map(feedCell)
// Legacy rows: they answer 404 (no feed), so they are neither the sample nor the denominator.
const LEGACY = Array.from({ length: 16 }, (_, index) => feedCell(`legacy${index}`))

const page = (cellId: string) =>
  new Response(JSON.stringify({ v: 1, cellId, incarnation: INCARNATION, seq: 0, at: 1, full: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
const answer = (status: number) => new Response('{}', { status })

// Every cell serves a feed page on the first round; `respond` answers every round after it.
function poller(
  respond: (cellId: string) => Response | Promise<Response>,
  options: { identityFails?: boolean; cells?: SeatFeedCell[]; neverServed?: ReadonlySet<string> } = {}
) {
  let now = 1_000
  let round = 0
  const logs: string[] = []
  const started = startShadowSeatPoller(
    { role: 'director', rehomeAudience: 'https://relay.example.test/rehome', shadowSeatFeedCells: 'all' },
    {
      listCells: async () => options.cells ?? CELLS,
      fetch: vi.fn(async (input: string | URL | Request) => {
        const cellId = new URL(String(input)).hostname.split('.')[0] ?? ''
        if (cellId.startsWith('legacy')) return answer(404)
        if (options.neverServed?.has(cellId)) return answer(502)
        return round === 0 ? page(cellId) : await respond(cellId)
      }),
      identityToken: vi.fn(async () => {
        if (options.identityFails && round > 0) throw new Error('metadata_unavailable')
        return 'token-1'
      }),
      now: () => now,
      pollMs: 3_600_000,
      log: (line) => logs.push(line)
    }
  )
  if (!started) throw new Error('poller not started')
  return {
    ...started,
    logs,
    // One poll a second for `ms`, after the first round of feed pages.
    run: async (ms: number) => {
      await started.tick()
      round = 1
      for (let elapsed = 0; elapsed <= ms; elapsed += 1_000) {
        now += 1_000
        await started.tick()
      }
      return now
    }
  }
}

describe('seat-feed poller reachability', () => {
  it('counts timeouts, connection failures and load-balancer 502/503/504 as unanswered', async () => {
    for (const fail of [
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      () => answer(502),
      () => answer(503),
      () => answer(504)
    ]) {
      const cells = poller((cellId) => (cellId === 'c2' ? fail() : page(cellId)))
      const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
      cells.stop()
      expect(cells.deadCellVerdict('c2', at)?.dead).toBe(true)
      expect(cells.deadCellVerdict('c1', at)).toBeNull()
    }
  })

  it('does not blame a cell for a token this director cannot mint', async () => {
    const cells = poller((cellId) => page(cellId), { identityFails: true })
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.deadCellVerdict('c2', at)).toBeNull()
  })

  it('counts only cells that served a feed: legacy 404 rows neither fill the sample nor dilute it', async () => {
    // Staging's shape: a few real cells and 16 legacy rows. Every real cell fails.
    const cells = poller(() => answer(502), { cells: [...CELLS.slice(0, 3), ...LEGACY] })
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.deadCellVerdict('c2', at)).toMatchObject({
      dead: false,
      withheld: 'sample',
      fleetFailing: 3,
      fleetPolled: 3
    })
  })

  it('a director restarted during a lone outage still judges the dead cell: the candidate is always sampled', async () => {
    // c2 died before this director started, so it never served it a feed page.
    const cells = poller((cellId) => (cellId === 'c2' ? answer(502) : page(cellId)), {
      neverServed: new Set(['c2'])
    })
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.deadCellVerdict('c2', at)).toMatchObject({
      dead: true,
      fleetFailing: 1,
      fleetPolled: 6,
      regionFailing: 1,
      regionPolled: 6
    })
  })

  it('a partition that began before the restart withholds: the candidate is its region\'s only sample', async () => {
    const asia = ['a1', 'a2', 'a3'].map((cellId) => ({ ...feedCell(cellId), region: 'asia-east2' as const }))
    const cells = poller((cellId) => (cellId.startsWith('a') ? answer(502) : page(cellId)), {
      cells: [...CELLS, ...asia],
      neverServed: new Set(['a1', 'a2', 'a3'])
    })
    const at = await cells.run(CELL_POLL_DEAD_STREAK_MS)
    cells.stop()
    expect(cells.deadCellVerdict('a1', at)).toMatchObject({
      dead: false,
      withheld: 'region',
      fleetPolled: 7,
      regionFailing: 1,
      regionPolled: 1
    })
  })

  it('counts no cell without capacity, the candidate included', async () => {
    const empty = (cell: SeatFeedCell) => ({ ...cell, capacityRequests: 0 })
    const peersEmpty = poller((cellId) => (cellId === 'c2' ? answer(502) : page(cellId)), {
      cells: CELLS.map((cell) => (['c4', 'c5', 'c6'].includes(cell.cellId) ? empty(cell) : cell))
    })
    const at = await peersEmpty.run(CELL_POLL_DEAD_STREAK_MS)
    peersEmpty.stop()
    expect(peersEmpty.deadCellVerdict('c2', at)).toMatchObject({ withheld: 'sample', fleetPolled: 3 })

    const candidateEmpty = poller((cellId) => (cellId === 'c2' ? answer(502) : page(cellId)), {
      cells: CELLS.map((cell) => (cell.cellId === 'c2' ? empty(cell) : cell))
    })
    const candidateAt = await candidateEmpty.run(CELL_POLL_DEAD_STREAK_MS)
    candidateEmpty.stop()
    expect(candidateEmpty.deadCellVerdict('c2', candidateAt)).toMatchObject({ withheld: 'sample', fleetPolled: 5 })
  })

})
