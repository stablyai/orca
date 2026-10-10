import { describe, expect, it, vi } from 'vitest'
import type { CellReserveClient } from './cell-reserve-client.js'
import { ReserveAssignment, ReservePaceError, RESERVE_STARTUP_GATE_MS } from './reserve-assignment.js'
import { ReservePlacer, type ReserveAttempt } from './reserve-placement.js'
import { ShadowSeatDirectory, type SeatFeedCell, type SeatFeedResponse } from './shadow-seat-directory.js'

const HOST = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
const US = 'us-central1' as const

function cellList(ids: string[], region = US): SeatFeedCell[] {
  return ids.map((cellId) => ({
    cellId,
    cellUrl: `https://${cellId}.example`,
    region,
    heartbeatExpiresAt: Number.MAX_SAFE_INTEGER,
    requiredForComplete: true,
    general: true
  }))
}

function feed(
  cellId: string,
  overrides: Partial<SeatFeedResponse> & { admitMode?: 'db' | 'reserve' } = {}
): SeatFeedResponse {
  const { admitMode = 'reserve', ...rest } = overrides
  return {
    v: 1,
    cellId,
    incarnation: `${cellId}-incarnation-1`,
    seq: 1,
    at: 0,
    counts: { seats: 0, controls: 0, bookings: 0, units: 0, ceiling: 500 },
    intake: { perSec: 100, burst: 20, tokens: 20 },
    flagsApplied: { generation: 3, flags: { admitMode } },
    full: [],
    ...rest
  }
}

function setup(
  options: {
    cells?: SeatFeedCell[]
    feeds?: SeatFeedResponse[]
    reserve?: (cellId: string, sticky: boolean) => ReserveAttempt
    row?: (identity: { userId: string; relayHostId: string }) => Promise<{ cellId: string; assignmentEpoch: number } | null>
    mode?: 'off' | 'dry-run' | 'on'
    startedAt?: number
  } = {}
) {
  const now = { value: 100_000 }
  const cells = options.cells ?? cellList(['c1', 'c2'])
  const directory = new ShadowSeatDirectory()
  directory.setCells(cells.map((cell) => cell.cellId))
  for (const response of options.feeds ?? cells.map((cell) => feed(cell.cellId))) {
    directory.apply(response.cellId, response, now.value - 1, now.value - 1)
  }
  const reserved: Array<{ cellId: string; epoch: number; sticky: boolean; dryRun: boolean }> = []
  const demoted: Array<{ cellId: string; epoch: number; joinedAt: number }> = []
  const client = {
    reserve: vi.fn(async (target: { cellId: string }, item: { epoch: number; sticky?: boolean }, dryRun = false) => {
      reserved.push({ cellId: target.cellId, epoch: item.epoch, sticky: item.sticky ?? false, dryRun })
      return options.reserve?.(target.cellId, item.sticky ?? false) ?? { outcome: 'ok' }
    }),
    demote: vi.fn(async (target: { cellId: string }, request: { epoch: number; joinedAt: number }) => {
      demoted.push({ cellId: target.cellId, epoch: request.epoch, joinedAt: request.joinedAt })
      return true
    })
  } satisfies Pick<CellReserveClient, 'reserve' | 'demote'>
  // Each director's estimate starts empty; a second of refill gives it its share.
  const placer = new ReservePlacer(() => now.value, () => 0.25)
  const assignment = new ReserveAssignment({
    mode: options.mode ?? 'on',
    directory,
    cells: () => cells,
    startedAt: options.startedAt ?? 0,
    placer,
    // SAFETY: only reserve and demote are called, and both are implemented above.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: see above.
    client: client as unknown as CellReserveClient,
    readRow: options.row ?? (async () => null),
    now: () => now.value,
    random: () => 0.25,
    log: () => undefined
  })
  // Starts each cell's refill clock, as a director's first look does.
  for (const cell of assignment.placementCells()) placer.hasBudget(cell)
  now.value += 1_000
  for (const response of options.feeds ?? cells.map((cell) => feed(cell.cellId))) {
    directory.apply(response.cellId, { ...response, full: response.full ?? [] }, now.value - 1, now.value - 1)
  }
  return { assignment, directory, reserved, demoted, now }
}

function seated(epoch: number, joinedAt = 0) {
  return { ...HOST, epoch, generation: 1, state: 'active', joinedAt }
}

describe('reserve assignment on a director', () => {
  it('keeps today’s path when off, or when no cell reports reserve mode', async () => {
    expect((await setup({ mode: 'off' }).assignment.plan(HOST, { reconnect: true, region: US })).kind).toBe(
      'database'
    )
    const databaseOnly = setup({ feeds: [feed('c1', { admitMode: 'db' }), feed('c2', { admitMode: 'db' })] })
    expect(await databaseOnly.assignment.plan(HOST, { reconnect: false, region: US })).toEqual({
      kind: 'database'
    })
  })

  it('reads what each cell acts on: a tripped dead-man is db, a flip back still leasing is reserve', async () => {
    const tripped = setup({
      feeds: [feed('c1', { admitModeEffective: 'db' }), feed('c2', { admitModeEffective: 'db' })]
    })
    expect(await tripped.assignment.plan(HOST, { reconnect: false, region: US })).toEqual({ kind: 'database' })
    const leasing = setup({ feeds: [feed('c1', { admitMode: 'db', admitModeEffective: 'reserve' }), feed('c2')] })
    expect(leasing.directory.admitModeOf('c1')).toBe('reserve')
  })

  it('before every live cell has answered, holds back only hosts that may be on an unheard cell', async () => {
    const cells = cellList(['c1', 'c2'])
    const onUnheard = { ...HOST, relayHostId: 'qrstuvwxyzabcdef' }
    const gated = setup({
      cells,
      feeds: [feed('c1')],
      startedAt: 100_500,
      row: async (identity) =>
        identity.relayHostId === onUnheard.relayHostId ? { cellId: 'c2', assignmentEpoch: 3 } : null
    })
    // A fresh host goes to today's path, with no booking yet.
    expect(await gated.assignment.plan(HOST, { reconnect: false, region: US })).toEqual({
      kind: 'database',
      epochFloor: 0
    })
    expect(gated.reserved).toEqual([])
    expect(await gated.assignment.plan(onUnheard, { reconnect: true, region: US })).toMatchObject({
      kind: 'retry',
      reason: 'map-incomplete'
    })
    gated.now.value = 100_500 + RESERVE_STARTUP_GATE_MS
    expect((await gated.assignment.plan(onUnheard, { reconnect: true, region: US })).kind).not.toBe('retry')
  })

  it('answers a reconnect from memory at the same epoch with no booking and no database read', async () => {
    const row = vi.fn(async () => null)
    const { assignment, reserved } = setup({
      feeds: [feed('c1', { full: [seated(7)] }), feed('c2')],
      row
    })
    const plan = await assignment.plan(HOST, { reconnect: true, region: US })
    expect(plan).toMatchObject({ kind: 'answer', lane: 'sticky', assignment: { cellId: 'c1', assignmentEpoch: 7 } })
    expect(reserved).toEqual([])
    expect(row).not.toHaveBeenCalled()
  })

  it('re-books a host on a cell that restarted since its seat, and only then answers it', async () => {
    const { assignment, directory, reserved, now } = setup({
      feeds: [feed('c1', { full: [seated(7)] }), feed('c2')]
    })
    // The cell restarted: its full snapshot no longer holds the seat.
    directory.apply('c1', feed('c1', { incarnation: 'c1-incarnation-2' }), now.value, now.value)
    const plan = await assignment.plan(HOST, { reconnect: true, region: US })
    expect(reserved[0]).toEqual({ cellId: 'c1', epoch: 7, sticky: true, dryRun: false })
    expect(plan).toMatchObject({ kind: 'answer', lane: 'sticky', assignment: { cellId: 'c1', assignmentEpoch: 7 } })
  })

  it('never sends a drained or demoted host back, and books it elsewhere above every known epoch', async () => {
    const { assignment, directory, reserved, now } = setup()
    directory.apply(
      'c1',
      feed('c1', {
        full: undefined,
        seq: 3,
        changes: [
          { seq: 2, kind: 'join', ...HOST, epoch: 7, generation: 1, at: 1 },
          { seq: 3, kind: 'leave', ...HOST, epoch: 7, generation: 1, closeCode: 4503, at: 2 }
        ]
      }),
      now.value,
      now.value
    )
    const plan = await assignment.plan(HOST, { reconnect: true, region: US })
    expect(plan).toMatchObject({ kind: 'answer', lane: 'placement', assignment: { assignmentEpoch: 8 } })
    expect(reserved.every((call) => !call.sticky && call.epoch === 8)).toBe(true)
  })

  it('leaves a host the map last saw on a database-mode cell to today’s path, with the floor', async () => {
    const { assignment } = setup({
      feeds: [feed('c1', { admitMode: 'db', full: [seated(4)] }), feed('c2')]
    })
    const plan = await assignment.plan(HOST, { reconnect: true, region: US })
    expect(plan).toMatchObject({ kind: 'database', epochFloor: 4 })
    expect(plan.kind === 'database' && typeof plan.placeFresh).toBe('function')
  })

  it('leaves a cell without a feed (c17/c18) on today’s path without starving the reserve pool', async () => {
    const cells = cellList(['c1', 'c2', 'c17'])
    let rowOnOld = false
    const { assignment, directory, reserved, now } = setup({
      cells,
      feeds: [feed('c1'), feed('c2', { admitMode: 'db' })],
      row: async () => (rowOnOld ? { cellId: 'c17', assignmentEpoch: 5 } : null)
    })
    directory.markNoFeed('c17', now.value)
    expect(directory.isComplete()).toBe(true)
    // An old image reports no ceiling; counting it as a database cell would zero the share.
    expect(await assignment.plan(HOST, { reconnect: false, region: US })).toMatchObject({
      kind: 'answer',
      lane: 'placement',
      assignment: { cellId: 'c1' }
    })
    expect(reserved.map((call) => call.cellId)).not.toContain('c17')
    rowOnOld = true
    expect(
      await assignment.plan({ ...HOST, relayHostId: 'qrstuvwxyzabcdef' }, { reconnect: true, region: US })
    ).toMatchObject({ kind: 'database', epochFloor: 5 })
    // A cell that rolled back to an image without the feed takes no placement.
    directory.markNoFeed('c1', now.value)
    expect(directory.cellState('c1')?.ceiling).toBeUndefined()
    expect(assignment.placementCells().find((cell) => cell.cellId === 'c1')?.general).toBe(false)
  })

  it('reads the row once for a host the map never saw, and refuses it while the database is down', async () => {
    const down = setup({ row: async () => Promise.reject(new Error('timeout')) })
    expect(await down.assignment.plan(HOST, { reconnect: false, region: US })).toMatchObject({
      kind: 'retry',
      reason: 'database'
    })
    const known = setup({ row: async () => ({ cellId: 'c1', assignmentEpoch: 11 }) })
    expect(await known.assignment.plan(HOST, { reconnect: false, region: US })).toMatchObject({
      kind: 'answer',
      assignment: { assignmentEpoch: 12 }
    })
  })

  it('paces with Retry-After when every reserve cell is out of budget and no database cell exists', async () => {
    const { assignment } = setup({ reserve: () => ({ outcome: 'intake' }) })
    await expect(assignment.plan(HOST, { reconnect: false, region: US })).rejects.toBeInstanceOf(
      ReservePaceError
    )
  })

  it('tells the old reserve seat to go when it books the host elsewhere, naming that seat exactly', async () => {
    const { assignment, directory, demoted, now } = setup({
      feeds: [feed('c1', { full: [seated(5, 1_000)] }), feed('c2')],
      // c1 is full, so the host lands on c2.
      reserve: (cellId) => (cellId === 'c1' ? { outcome: 'full' } : { outcome: 'ok' })
    })
    // The host left c1 for a reason that moves it: its next placement is fresh, above 5.
    directory.apply(
      'c1',
      feed('c1', {
        full: undefined,
        seq: 2,
        changes: [{ seq: 2, kind: 'drain-only', ...HOST, epoch: 5, generation: 1, at: 2 }]
      }),
      now.value,
      now.value
    )
    const plan = await assignment.plan(HOST, { reconnect: true, region: US })
    expect(plan).toMatchObject({ kind: 'answer', lane: 'placement', assignment: { assignmentEpoch: 6 } })
    expect(demoted).toEqual([{ cellId: 'c1', epoch: 5, joinedAt: 1_000 }])
  })

  it('answers a reconnect only at the newest epoch, newest join first', async () => {
    const { assignment, reserved } = setup({
      feeds: [feed('c1', { full: [seated(6, 1_000)] }), feed('c2', { full: [seated(5, 3_000)] })]
    })
    // c2's seat joined later but at an older epoch: a stale rebind, never the answer.
    expect(await assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
      kind: 'answer',
      lane: 'sticky',
      assignment: { cellId: 'c1', assignmentEpoch: 6 }
    })
    expect(reserved).toEqual([])
  })

  it('in dry run only asks a cell to check a booking, and never changes the answer', async () => {
    const { assignment, reserved } = setup({ mode: 'dry-run' })
    const plan = await assignment.plan(HOST, { reconnect: false, region: US })
    expect(plan.kind).toBe('database')
    expect(plan.kind === 'database' && (await plan.placeFresh?.())).toBeNull()
    expect(reserved).toMatchObject([{ dryRun: true }])
  })
})
