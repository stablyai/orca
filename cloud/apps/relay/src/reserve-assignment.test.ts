import { describe, expect, it, vi } from 'vitest'
import type { RelayRegion } from '@orca-cloud/relay-contract'
import type { CellReserveClient } from './cell-reserve-client.js'
import {
  ReserveAssignment,
  ReservePaceError,
  RESERVE_ROW_FLOOR_TTL_MS,
  RESERVE_WRONG_CELL_ROW_READ_MS,
  RESERVE_STARTUP_GATE_MS
} from './reserve-assignment.js'
import { ReservePlacer, type ReserveAttempt } from './reserve-placement.js'
import { ReserveRehome } from './reserve-rehome.js'
import { ShadowSeatDirectory, type SeatFeedCell, type SeatFeedResponse } from './shadow-seat-directory.js'

const HOST = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
const US = 'us-central1' as const

function cellList(ids: string[], region: RelayRegion = US): SeatFeedCell[] {
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
    databaseBusy?: () => boolean
    mode?: 'off' | 'dry-run' | 'on'
    startedAt?: number
    log?: (line: string) => void
    demote?: (cellId: string) => string | null
    rehome?: ReserveRehome
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
      return options.demote ? options.demote(target.cellId) : 'demoted'
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
    ...(options.databaseBusy ? { databaseBusy: options.databaseBusy } : {}),
    ...(options.rehome ? { rehome: options.rehome } : {}),
    now: () => now.value,
    random: () => 0.25,
    log: options.log ?? (() => undefined)
  })
  // Starts each cell's refill clock, as a director's first look does.
  for (const cell of assignment.placementCells()) placer.hasBudget(cell)
  now.value += 1_000
  for (const response of options.feeds ?? cells.map((cell) => feed(cell.cellId))) {
    directory.apply(response.cellId, { ...response, full: response.full ?? [] }, now.value - 1, now.value - 1)
  }
  return { assignment, directory, reserved, demoted, now, placer }
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
    // A tripped cell still re-registering reports reserve as effective but db as raw: placement
    // treats it as a database cell at once, books nothing there and paces nobody for it.
    const reregistering = setup({
      feeds: [
        feed('c1', { admitModeEffective: 'reserve', admitModeRaw: 'db' }),
        feed('c2', { admitModeEffective: 'reserve', admitModeRaw: 'db' })
      ]
    })
    expect(await reregistering.assignment.plan(HOST, { reconnect: false, region: US })).toEqual({ kind: 'database' })
    expect(reregistering.reserved).toEqual([])
    expect(reregistering.directory.admitModeOf('c1')).toBe('reserve')
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

  it('after the reconcile demotes a seat behind its row, mints above the row and never answers that seat', async () => {
    const { assignment, directory, reserved, now } = setup({
      feeds: [feed('c1', { full: [seated(7)] }), feed('c2')]
    })
    // The row names another cell at epoch 8; the mirror would refuse a re-assign at 8.
    assignment.raiseEpochFloor(HOST, 8)
    const plan = await assignment.plan(HOST, { reconnect: true, region: US })
    expect(plan).toMatchObject({
      kind: 'answer',
      lane: 'placement',
      assignment: { assignmentEpoch: 9 }
    })
    expect(reserved.length).toBeGreaterThan(0)
    expect(reserved.every((call) => !call.sticky && call.epoch === 9)).toBe(true)
    // The floor lapses, so a host it no longer protects answers from memory again.
    now.value += RESERVE_ROW_FLOOR_TTL_MS + 1
    for (const response of [feed('c1', { seq: 2, full: [seated(7)] }), feed('c2', { seq: 2 })]) {
      directory.apply(response.cellId, response, now.value, now.value)
    }
    expect(await assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
      lane: 'sticky'
    })
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
    expect(plan).toMatchObject({
      kind: 'answer',
      lane: 'placement',
      assignment: { assignmentEpoch: 8 }
    })
    expect(reserved.length).toBeGreaterThan(0)
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
    const read = vi.fn(async () => ({ cellId: 'c1', assignmentEpoch: 11 }))
    const known = setup({ row: read })
    expect(await known.assignment.plan(HOST, { reconnect: false, region: US })).toMatchObject({
      kind: 'answer',
      assignment: { assignmentEpoch: 12 }
    })
    expect(read).toHaveBeenCalledExactlyOnceWith(HOST)
  })

  it('after a WRONG_CELL leave, any director reads the row and mints above it', async () => {
    const leftWrongCell = (
      row: () => Promise<{ cellId: string; assignmentEpoch: number } | null>,
      databaseBusy?: () => boolean
    ) => {
      const harness = setup({ row, ...(databaseBusy ? { databaseBusy } : {}) })
      // Another director demoted the seat: this one only sees the leave in c1's feed.
      harness.directory.apply(
        'c1',
        feed('c1', {
          full: undefined,
          seq: 3,
          changes: [
            { seq: 2, kind: 'join', ...HOST, epoch: 7, generation: 1, at: 1 },
            { seq: 3, kind: 'leave', ...HOST, epoch: 7, generation: 1, closeCode: 4409, at: 2 }
          ]
        }),
        harness.now.value,
        harness.now.value
      )
      return harness
    }
    const row = vi.fn(async () => ({ cellId: 'c2', assignmentEpoch: 8 }))
    const read = leftWrongCell(row)
    expect(await read.assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
      kind: 'answer',
      lane: 'placement',
      assignment: { assignmentEpoch: 9 }
    })
    expect(row).toHaveBeenCalledTimes(1)
    // The database down: placed as before the read existed, above what the map knows.
    const down = leftWrongCell(async () => Promise.reject(new Error('timeout')))
    expect(await down.assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
      kind: 'answer',
      assignment: { assignmentEpoch: 8 }
    })
    // Pool waiters: the read is skipped outright, so a stall cannot stack timed-out reads.
    const busyRow = vi.fn(async () => ({ cellId: 'c2', assignmentEpoch: 8 }))
    const busy = leftWrongCell(busyRow, () => true)
    expect(await busy.assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
      kind: 'answer',
      assignment: { assignmentEpoch: 8 }
    })
    expect(busyRow).not.toHaveBeenCalled()
    // A stalled database: the read gives up after its bound and places as before.
    vi.useFakeTimers()
    try {
      const stalled = leftWrongCell(() => new Promise(() => undefined))
      const plan = stalled.assignment.plan(HOST, { reconnect: true, region: US })
      await vi.advanceTimersByTimeAsync(RESERVE_WRONG_CELL_ROW_READ_MS)
      expect(await plan).toMatchObject({ kind: 'answer', assignment: { assignmentEpoch: 8 } })
    } finally {
      vi.useRealTimers()
    }
  })

  describe('for a share-draw loser', () => {
    const ASIA = 'asia-east2' as const
    const OTHER = { ...HOST, relayHostId: 'qrstuvwxyzabcdef' }
    const setupAsia = (reserveCell = feed('c1'), reserve?: (cellId: string) => ReserveAttempt) =>
      setup({
        ...(reserve ? { reserve } : {}),
        cells: [...cellList(['c1', 'c2'], ASIA), ...cellList(['c3'])],
        feeds: [
          reserveCell,
          // Database room far above the reserve cell's, so the 0.25 draw loses.
          feed('c2', {
            admitMode: 'db',
            counts: { seats: 0, controls: 0, bookings: 0, units: 0, ceiling: 5_000 }
          }),
          feed('c3')
        ]
      })
    const regionReserveOf = async (assignment: ReserveAssignment, identity = HOST) => {
      const plan = await assignment.plan(identity, { reconnect: false, region: ASIA })
      expect(plan).toMatchObject({ kind: 'database', epochFloor: 0 })
      return plan.kind === 'database' ? plan.regionReserve : undefined
    }

    it('offers the reserve cell in its region only, only while it has a seat', async () => {
      const { assignment, reserved, directory, now } = setupAsia()
      const regionReserve = await regionReserveOf(assignment)
      expect(reserved).toEqual([])
      await expect(regionReserve?.()).resolves.toMatchObject({ cellId: 'c1', region: ASIA })
      expect(reserved.map((call) => call.cellId)).toEqual(['c1'])
      // A full reserve cell is not offered, and the US reserve cell never is.
      const full = feed('c1', { counts: { seats: 500, controls: 500, bookings: 0, units: 500, ceiling: 500 } })
      directory.apply('c1', full, now.value, now.value)
      expect(await regionReserveOf(assignment, OTHER)).toBeUndefined()
      expect(reserved.map((call) => call.cellId)).toEqual(['c1'])
    })

    it('paces when the reserve cell has seats but no intake budget, rather than give up the region', async () => {
      const { assignment, reserved } = setupAsia(feed('c1', { intake: { perSec: 1, burst: 20, tokens: 0 } }))
      const regionReserve = await regionReserveOf(assignment)
      await expect(regionReserve?.()).rejects.toBeInstanceOf(ReservePaceError)
      expect(reserved).toEqual([])
    })

    it('gives the region up when the reserve cell refuses with a seat still on the map', async () => {
      for (const outcome of ['full', 'unreachable']) {
        const { assignment, reserved } = setupAsia(feed('c1'), (cellId) =>
          cellId === 'c1' ? { outcome } : { outcome: 'ok' }
        )
        const regionReserve = await regionReserveOf(assignment)
        // Null sends the host to the database lane's cross-region fallback, not a 1 s retry.
        await expect(regionReserve?.()).resolves.toBeNull()
        expect(reserved.map((call) => call.cellId)).toEqual(['c1'])
      }
    })
  })

  describe('for a region-correction request', () => {
    const request = { reconnect: true, region: US, regionCorrection: true }

    it('leaves the answer to the database lane, offering only the in-region reserve fallback and the spill', async () => {
      const row = vi.fn(async () => null)
      // A memory answer would skip the window exchange; the share draw is not offered either.
      const { assignment, reserved } = setup({ feeds: [feed('c1', { full: [seated(7)] }), feed('c2')], row })
      const plan = await assignment.plan(HOST, request)
      expect(plan).toEqual({
        kind: 'database',
        regionReserve: expect.any(Function),
        reserveSpill: expect.any(Function)
      })
      expect(reserved).toEqual([])
      expect(row).not.toHaveBeenCalled()
      await expect(plan.kind === 'database' ? plan.regionReserve?.() : null).resolves.toMatchObject({
        assignmentEpoch: 8
      })
    })

    it('keeps today’s path for a host the map never saw, without reading its row, but may spill', async () => {
      const row = vi.fn(async () => ({ cellId: 'c1', assignmentEpoch: 3 }))
      const { assignment, reserved } = setup({ row })
      const plan = await assignment.plan(HOST, request)
      expect(plan).toEqual({ kind: 'database', reserveSpill: expect.any(Function) })
      expect(row).not.toHaveBeenCalled()
      expect(reserved).toEqual([])
      // The database lane read the row: the spill mints above it.
      await expect(
        plan.kind === 'database' ? plan.reserveSpill?.({ skipOwnRegion: false, rowEpoch: 3 }) : null
      ).resolves.toMatchObject({ assignmentEpoch: 4 })
    })

    it('keeps today’s path while the map is incomplete, and in dry run', async () => {
      const gated = setup({ cells: cellList(['c1', 'c2']), feeds: [feed('c1', { full: [seated(4)] })], startedAt: 100_500 })
      expect(await gated.assignment.plan(HOST, request)).toEqual({ kind: 'database' })
      const dryRun = setup({ mode: 'dry-run', feeds: [feed('c1', { full: [seated(4)] }), feed('c2')] })
      expect(await dryRun.assignment.plan(HOST, request)).toEqual({ kind: 'database' })
      expect([...gated.reserved, ...dryRun.reserved]).toEqual([])
    })
  })

  describe('after the database lane found no cell anywhere', () => {
    const ASIA = 'asia-east2' as const
    const paced = { intake: { perSec: 1, burst: 20, tokens: 0 } }
    const fullCounts = { counts: { seats: 500, controls: 500, bookings: 0, units: 500, ceiling: 500 } }
    // The host sits on an Asia database cell, so the plan goes to the database lane.
    const setupSpill = (asiaReserve: Partial<SeatFeedResponse>, usReserve: Partial<SeatFeedResponse> = {}, log?: (line: string) => void) =>
      setup({
        ...(log ? { log } : {}),
        cells: [...cellList(['asia-r', 'asia-db'], ASIA), ...cellList(['us-r'])],
        feeds: [
          feed('asia-r', asiaReserve),
          feed('asia-db', { admitMode: 'db', full: [seated(4)] }),
          feed('us-r', usReserve)
        ]
      })
    const spillOf = async (harness: ReturnType<typeof setup>, request: { regionCorrection?: boolean } = {}) => {
      const plan = await harness.assignment.plan(HOST, { reconnect: true, region: ASIA, ...request })
      expect(plan.kind).toBe('database')
      return plan.kind === 'database' ? plan.reserveSpill : undefined
    }

    it('books its own region first, minting above the row the database lane read', async () => {
      const harness = setupSpill({})
      const spill = await spillOf(harness)
      await expect(spill?.({ skipOwnRegion: false, rowEpoch: 9 })).resolves.toMatchObject({
        cellId: 'asia-r',
        region: ASIA,
        assignmentEpoch: 10
      })
      expect(harness.reserved).toEqual([{ cellId: 'asia-r', epoch: 10, sticky: false, dryRun: false }])
    })

    it('books the other region when its own is full, or already tried', async () => {
      const full = setupSpill(fullCounts)
      await expect((await spillOf(full))?.({ skipOwnRegion: false, rowEpoch: 0 })).resolves.toMatchObject({
        cellId: 'us-r',
        region: US,
        assignmentEpoch: 5
      })
      const tried = setupSpill({})
      await expect((await spillOf(tried))?.({ skipOwnRegion: true, rowEpoch: 0 })).resolves.toMatchObject({
        cellId: 'us-r'
      })
      expect(tried.reserved.map((call) => call.cellId)).toEqual(['us-r'])
    })

    it('tries the other region after a pace, and answers the pace only if nothing places', async () => {
      const abroad = setupSpill(paced)
      await expect((await spillOf(abroad))?.({ skipOwnRegion: false, rowEpoch: 0 })).resolves.toMatchObject({
        cellId: 'us-r'
      })
      const nowhere = setupSpill(paced, fullCounts)
      await expect((await spillOf(nowhere))?.({ skipOwnRegion: false, rowEpoch: 0 })).rejects.toBeInstanceOf(
        ReservePaceError
      )
    })

    it('returns null with no reserve seat anywhere, so the refusal stands', async () => {
      const harness = setupSpill(fullCounts, fullCounts)
      await expect((await spillOf(harness))?.({ skipOwnRegion: false, rowEpoch: 0 })).resolves.toBeNull()
      expect(harness.reserved).toEqual([])
    })

    it('is not offered while the map is incomplete', async () => {
      const gated = setup({
        cells: [...cellList(['asia-r', 'asia-db'], ASIA), ...cellList(['us-r'])],
        feeds: [feed('asia-r'), feed('asia-db', { admitMode: 'db', full: [seated(4)] })],
        startedAt: 100_500
      })
      const plan = await gated.assignment.plan(HOST, { reconnect: true, region: ASIA })
      expect(plan).toMatchObject({ kind: 'database' })
      expect(plan.kind === 'database' && plan.reserveSpill).toBeUndefined()
      const correction = await gated.assignment.plan(HOST, { reconnect: true, region: ASIA, regionCorrection: true })
      expect(correction).toEqual({ kind: 'database' })
    })

    it('answers the shortest pace when every region paces', async () => {
      const harness = setupSpill(paced, { intake: { perSec: 2, burst: 20, tokens: 0 } })
      const spill = await spillOf(harness)
      // Asia refills its token in 4 s, US in 2 s.
      await expect(spill?.({ skipOwnRegion: false, rowEpoch: 0 })).rejects.toSatisfy(
        (error) => error instanceof ReservePaceError && error.retryAfterSeconds === 2
      )
    })

    it('counts a spill once, not as a database fallback or a pace per region', async () => {
      for (const [asiaReserve, label] of [
        [fullCounts, 'full'],
        [paced, 'paced']
      ] as const) {
        const lines: Record<string, unknown>[] = []
        const harness = setupSpill(asiaReserve, {}, (line) => lines.push(JSON.parse(line)))
        await (await spillOf(harness))?.({ skipOwnRegion: false, rowEpoch: 0 })
        harness.now.value += 60_000
        await harness.assignment.plan(HOST, { reconnect: true, region: ASIA })
        expect(lines.find((line) => line.event === 'orca_relay_reserve_placement_summary'), label).toMatchObject({
          spill: 1,
          placed: 1,
          database: 0,
          retries: { paced: 0 }
        })
        expect(lines.filter((line) => line.event === 'orca_relay_reserve_spill'), label).toEqual([
          { event: 'orca_relay_reserve_spill', fromRegion: ASIA, toRegion: US, count: 1 }
        ])
      }
    })
  })

  describe('rehome on reconnect', () => {
    const ASIA = 'asia-east2' as const
    const OTHER = { ...HOST, relayHostId: 'qrstuvwxyzabcdef' }
    const ask = { reconnect: true, region: ASIA, preferred: true }
    // 2,000 controls on the US cell refill its move budget once a minute.
    const usCounts = { counts: { seats: 1, controls: 2_000, bookings: 0, units: 1, ceiling: 4_000 } }
    const asiaFull = (share: number) => ({
      counts: { seats: Math.round(share * 1_000), controls: 0, bookings: 0, units: Math.round(share * 1_000), ceiling: 1_000 }
    })
    const setupRehome = (
      options: {
        asia?: Partial<SeatFeedResponse>
        usSeats?: ReturnType<typeof seated>[]
        reserve?: (cellId: string) => ReserveAttempt
        log?: (line: string) => void
        percent?: number
        switchOpen?: boolean
      } = {}
    ) => {
      const feeds = () => [
        feed('us-r', { ...usCounts, full: options.usSeats ?? [seated(5, 1_000)] }),
        feed('asia-r', { ...asiaFull(0.5), ...options.asia })
      ]
      const harness = setup({
        cells: [...cellList(['us-r']), ...cellList(['asia-r'], ASIA)],
        feeds: feeds(),
        rehome: new ReserveRehome({ percent: options.percent ?? 100, switchOpen: () => options.switchOpen ?? true }),
        ...(options.reserve ? { reserve: options.reserve } : {}),
        ...(options.log ? { log: options.log } : {})
      })
      // The first ask starts the US cell's empty budget; a minute later it holds one move.
      const warm = async () => {
        expect(await harness.assignment.plan(HOST, ask)).toMatchObject({ lane: 'sticky' })
        harness.now.value += 60_000
        for (const response of feeds()) {
          harness.directory.apply(response.cellId, { ...response, seq: 2 }, harness.now.value, harness.now.value)
        }
      }
      return { ...harness, warm }
    }

    it('books an Asia-preferring host on its own region, above every known epoch, and supersedes the US seat', async () => {
      const { assignment, demoted, warm } = setupRehome()
      await warm()
      expect(await assignment.plan(HOST, ask)).toMatchObject({
        kind: 'answer',
        lane: 'rehome',
        assignment: { cellId: 'asia-r', region: ASIA, assignmentEpoch: 6 }
      })
      expect(demoted).toEqual([{ cellId: 'us-r', epoch: 5, joinedAt: 1_000 }])
    })

    it('answers a region-correction request on the rehome lane', async () => {
      const { assignment, warm } = setupRehome()
      await warm()
      expect(await assignment.plan(HOST, { ...ask, regionCorrection: true })).toMatchObject({
        kind: 'answer',
        lane: 'rehome'
      })
    })

    // Jinwoo's condition: no move into a region without real room. Asia at 98% full gets none.
    it('moves no one into Asia at 98% full, or anywhere under 10% free', async () => {
      for (const share of [0.98, 0.91]) {
        const { assignment, reserved, warm } = setupRehome({ asia: asiaFull(share) })
        await warm()
        expect(await assignment.plan(HOST, ask), String(share)).toMatchObject({
          kind: 'answer',
          lane: 'sticky',
          assignment: { cellId: 'us-r' }
        })
        expect(reserved.filter((call) => call.cellId === 'asia-r')).toEqual([])
      }
      // 10% free is the line: the host moves.
      const { assignment, warm } = setupRehome({ asia: asiaFull(0.9) })
      await warm()
      expect(await assignment.plan(HOST, ask)).toMatchObject({ lane: 'rehome' })
    })

    // Room under 10% still takes placements (and B's spill, which books down to 0%), but C does
    // not move anyone into it: the gap that keeps a spilled host from bouncing back.
    it('keeps a gap above the spill line: 5% free takes placements, not rehomes', async () => {
      const { assignment, warm } = setupRehome({ asia: asiaFull(0.95) })
      await warm()
      expect(await assignment.plan(HOST, ask)).toMatchObject({ lane: 'sticky', assignment: { cellId: 'us-r' } })
      expect(await assignment.plan(OTHER, { reconnect: false, region: ASIA })).toMatchObject({
        lane: 'placement',
        assignment: { cellId: 'asia-r' }
      })
    })

    it('keeps today’s answer when any rule fails', async () => {
      const sticky = { kind: 'answer', lane: 'sticky', assignment: { cellId: 'us-r' } }
      const unhinted = setupRehome()
      await unhinted.warm()
      expect(await unhinted.assignment.plan(HOST, { ...ask, preferred: false })).toMatchObject(sticky)
      const off = setupRehome({ percent: 0 })
      await off.warm()
      expect(await off.assignment.plan(HOST, ask)).toMatchObject(sticky)
      const closed = setupRehome({ switchOpen: false })
      await closed.warm()
      expect(await closed.assignment.plan(HOST, ask)).toMatchObject(sticky)
      const cold = setupRehome()
      // No minute has passed: the US cell's move budget is still empty.
      expect(await cold.assignment.plan(HOST, ask)).toMatchObject(sticky)
      const sameRegion = setupRehome()
      await sameRegion.warm()
      expect(await sameRegion.assignment.plan(HOST, { ...ask, region: US })).toMatchObject(sticky)
    })

    it('never runs for a fresh ask, an unknown host, a database-mode source, or an incomplete map', async () => {
      const fresh = setupRehome()
      await fresh.warm()
      // A fresh ask is placed as today (the share draw), not rehomed.
      expect(await fresh.assignment.plan(HOST, { ...ask, reconnect: false })).toMatchObject({ lane: 'placement' })
      // Never seen: placed fresh in its own region by the share draw, not rehomed.
      expect(await fresh.assignment.plan(OTHER, ask)).toMatchObject({ kind: 'answer', lane: 'placement' })
      const onDatabase = setup({
        cells: [...cellList(['us-db']), ...cellList(['asia-r'], ASIA)],
        feeds: [feed('us-db', { admitMode: 'db', ...usCounts, full: [seated(5, 1_000)] }), feed('asia-r', asiaFull(0.5))],
        rehome: new ReserveRehome({ percent: 100, switchOpen: () => true })
      })
      expect(await onDatabase.assignment.plan(HOST, ask)).toMatchObject({ kind: 'database' })
      const gated = setup({
        cells: [...cellList(['us-r']), ...cellList(['asia-r', 'asia-unheard'], ASIA)],
        feeds: [feed('us-r', { ...usCounts, full: [seated(5, 1_000)] }), feed('asia-r', asiaFull(0.5))],
        startedAt: 100_500,
        rehome: new ReserveRehome({ percent: 100, switchOpen: () => true })
      })
      expect(await gated.assignment.plan(HOST, ask)).toMatchObject({ lane: 'sticky' })
      expect(gated.reserved).toEqual([])
    })

    it('passes a region-correction request to the database lane when rehome has no room', async () => {
      const { assignment, warm } = setupRehome({ asia: asiaFull(0.98) })
      await warm()
      expect(await assignment.plan(HOST, { ...ask, regionCorrection: true })).toEqual({
        kind: 'database',
        regionReserve: expect.any(Function),
        reserveSpill: expect.any(Function)
      })
    })

    it('falls through to the sticky answer when the rehome booking is paced', async () => {
      const { assignment, reserved, warm } = setupRehome({
        reserve: (cellId) => (cellId === 'asia-r' ? { outcome: 'intake' } : { outcome: 'ok' })
      })
      await warm()
      expect(await assignment.plan(HOST, ask)).toMatchObject({ kind: 'answer', lane: 'sticky' })
      // The booking was asked for and refused on intake: the pace path ran.
      expect(reserved.map((call) => call.cellId)).toEqual(['asia-r'])
    })

    it('leaves a host another install keeps dropping', async () => {
      const { assignment, directory, now, warm } = setupRehome()
      await warm()
      directory.apply(
        'us-r',
        feed('us-r', {
          ...usCounts,
          full: undefined,
          seq: 3,
          changes: [{ seq: 3, kind: 'leave', ...HOST, epoch: 4, generation: 1, closeCode: 4408, at: now.value - 1 }]
        }),
        now.value,
        now.value
      )
      expect(await assignment.plan(HOST, ask)).toMatchObject({ lane: 'sticky' })
    })

    it('falls through to the sticky answer when the booking is refused, and gives the move back', async () => {
      let refuse = true
      const { assignment, warm } = setupRehome({
        reserve: (cellId) => (cellId === 'asia-r' && refuse ? { outcome: 'full' } : { outcome: 'ok' })
      })
      await warm()
      expect(await assignment.plan(HOST, ask)).toMatchObject({ lane: 'sticky' })
      refuse = false
      expect(await assignment.plan(HOST, ask)).toMatchObject({ lane: 'rehome' })
    })

    it('moves one host per source budget a minute, and logs moves and skips per region pair', async () => {
      const lines: Record<string, unknown>[] = []
      const { assignment, now, warm } = setupRehome({
        usSeats: [seated(5, 1_000), { ...OTHER, epoch: 5, generation: 1, state: 'active', joinedAt: 1_000 }],
        log: (line) => lines.push(JSON.parse(line))
      })
      await warm()
      expect(await assignment.plan(HOST, ask)).toMatchObject({ lane: 'rehome' })
      expect(await assignment.plan(OTHER, ask)).toMatchObject({ lane: 'sticky' })
      now.value += 60_000
      await assignment.plan({ ...HOST, relayHostId: 'flushflushflush1' }, ask)
      // The warm-up minute, then this one.
      expect(lines.filter((line) => line.event === 'orca_relay_reserve_rehome')).toEqual([
        { event: 'orca_relay_reserve_rehome', fromRegion: US, toRegion: ASIA, count: 0, skippedByRule: { 'source-budget': 1 } },
        { event: 'orca_relay_reserve_rehome', fromRegion: US, toRegion: ASIA, count: 1, skippedByRule: { 'source-budget': 1 } }
      ])
    })
  })

  it('paces with Retry-After when every reserve cell is out of budget and no database cell exists', async () => {
    const { assignment } = setup({ reserve: () => ({ outcome: 'intake' }) })
    await expect(assignment.plan(HOST, { reconnect: false, region: US })).rejects.toMatchObject({
      message: 'reserve_cells_paced',
      retryAfterSeconds: expect.any(Number)
    })
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

  // The booking map had not seen the c1 seat (half-open, joined within a poll lag): the feed
  // demotes it once both joins are in the map, instead of the 75 s silence close.
  it('tells an old reserve seat the booking missed to go once a newer join shows in the feed', () => {
    const { assignment, directory, demoted, now } = setup()
    directory.onOutranked = (seat) => assignment.supersedeOutranked(seat)
    directory.apply('c2', feed('c2', { full: [seated(6, 3_000)] }), now.value, now.value)
    expect(demoted).toEqual([])
    directory.apply('c1', feed('c1', { full: [seated(5, 1_000)] }), now.value, now.value)
    expect(demoted).toEqual([{ cellId: 'c1', epoch: 5, joinedAt: 1_000 }])
  })

  it('answers a reconnect at the newest epoch even when an older epoch joined later', async () => {
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

  it('in dry run counts outcomes per picked cell, and a `full` refusal while the map showed room', async () => {
    const summaries: Array<{ dryRun: Record<string, unknown> }> = []
    const dryRunOn = async (units: number, outcome: string) => {
      const { assignment, now } = setup({
        mode: 'dry-run',
        cells: cellList(['c1']),
        feeds: [feed('c1', { counts: { seats: units, controls: 0, bookings: 0, units, ceiling: 500 } })],
        reserve: () => ({ outcome }),
        log: (line) => summaries.push(JSON.parse(line))
      })
      for (let index = 0; index < 2; index += 1) {
        const plan = await assignment.plan(HOST, { reconnect: false, region: US })
        if (plan.kind === 'database') await plan.placeFresh?.()
      }
      // Lets the fire-and-forget dry-run reserves settle before the summary flushes.
      await Promise.resolve()
      now.value += 60_000
      await assignment.plan(HOST, { reconnect: false, region: US })
    }
    // 1 free seat of 500 is under the 1% bound; 250 free is far over it.
    await dryRunOn(499, 'full')
    await dryRunOn(250, 'full')
    await dryRunOn(250, 'ok')
    expect(summaries.map((summary) => summary.dryRun)).toMatchObject([
      {
        outcomes: { full: 2 },
        count: 2,
        cells: { c1: { outcomes: { full: 2 }, fullWithRoom: 0, minFullFreeShare: 0.002 } }
      },
      { outcomes: { full: 2 }, cells: { c1: { outcomes: { full: 2 }, fullWithRoom: 2, minFullFreeShare: 0.5 } } },
      { outcomes: { ok: 2 }, cells: { c1: { outcomes: { ok: 2 }, fullWithRoom: 0, minFullFreeShare: null } } }
    ])
  })

  describe('when a cell answers a demotion', () => {
    const outcomes = (lines: string[]) =>
      lines
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'orca_relay_reserve_demote_outcome')

    // The map follows the cell's feed: a refusing cell repairs that feed itself.
    it('logs the answer by host digest and leaves the seat to the feed', async () => {
      const lines: string[] = []
      const logged = Promise.withResolvers<void>()
      const { assignment, directory } = setup({
        feeds: [feed('c1', { full: [seated(10, 1_000)] }), feed('c2')],
        demote: () => 'not-seated',
        log: (line) => {
          lines.push(line)
          if (JSON.parse(line).event === 'orca_relay_reserve_demote_outcome') {
            logged.resolve()
          }
        }
      })
      assignment.demoteSeat({ ...HOST, cellId: 'c1', epoch: 10, joinedAt: 1_000 }, 'reconcile')
      await logged.promise
      expect(outcomes(lines)).toMatchObject([
        { via: 'reconcile', cellId: 'c1', epoch: 10, outcome: 'not-seated' }
      ])
      expect(outcomes(lines)[0].relayHostIdDigest).toMatch(/^[0-9a-f]{12}$/)
      expect(lines.join('\n')).not.toContain(HOST.relayHostId)
      expect(directory.seatsOnCell('c1')).toHaveLength(1)
    })

    it('records a cell it could not reach as unreachable', async () => {
      const lines: string[] = []
      const logged = Promise.withResolvers<void>()
      const { assignment } = setup({
        feeds: [feed('c1', { full: [seated(10, 1_000)] }), feed('c2')],
        demote: () => null,
        log: (line) => {
          lines.push(line)
          if (JSON.parse(line).event === 'orca_relay_reserve_demote_outcome') {
            logged.resolve()
          }
        }
      })
      assignment.demoteSeat({ ...HOST, cellId: 'c1', epoch: 10, joinedAt: 1_000 }, 'reconcile')
      await logged.promise
      expect(outcomes(lines)).toMatchObject([{ outcome: 'unreachable' }])
    })
  })

  describe('for a host re-asking off a draining cell', () => {
    const events = (lines: string[], event: string) =>
      lines.map((line) => JSON.parse(line)).filter((entry) => entry.event === event)
    const flushedSummary = async (assignment: ReserveAssignment, now: { value: number }, lines: string[]) => {
      now.value += 60_001
      await assignment.plan({ ...HOST, relayHostId: 'zzzzzzzzzzzzzzzz' }, { reconnect: false, region: US })
      return events(lines, 'orca_relay_reserve_placement_summary')[0]
    }

    // graceMs 0: the host re-asks while its seat still shows, but the cell's feed already says draining.
    it('counts the placement by source cell before any leave lands', async () => {
      const lines: string[] = []
      const { assignment, now } = setup({
        feeds: [feed('c1', { draining: true, full: [seated(7)] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      expect(await assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
        kind: 'answer',
        lane: 'placement',
        assignment: { cellId: 'c2', assignmentEpoch: 8 }
      })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toEqual([
        { event: 'orca_relay_reserve_drain_replaced', fromCellId: 'c1', toCellId: 'c2', region: US }
      ])
      expect((await flushedSummary(assignment, now, lines)).drainReplaced).toEqual({ c1: 1 })
    })

    it('counts a drain-only seat, and a newest leave on a draining cell', async () => {
      const lines: string[] = []
      const drainOnly = setup({
        feeds: [feed('c1', { full: [{ ...seated(7), state: 'drain-only' }] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      await drainOnly.assignment.plan(HOST, { reconnect: true, region: US })
      const left = setup({ feeds: [feed('c1', { draining: true }), feed('c2')], log: (line) => lines.push(line) })
      left.directory.apply(
        'c1',
        feed('c1', {
          draining: true,
          full: undefined,
          seq: 3,
          changes: [
            { seq: 2, kind: 'join', ...HOST, epoch: 7, generation: 1, at: 1 },
            { seq: 3, kind: 'leave', ...HOST, epoch: 7, generation: 1, closeCode: 4503, at: 2 }
          ]
        }),
        left.now.value,
        left.now.value
      )
      await left.assignment.plan(HOST, { reconnect: true, region: US })
      expect(events(lines, 'orca_relay_reserve_drain_replaced').map((entry) => entry.fromCellId)).toEqual([
        'c1',
        'c1'
      ])
    })

    it('counts a host once: after its re-booking, a second ask is not a drain re-ask', async () => {
      const lines: string[] = []
      const { assignment, directory, now } = setup({
        feeds: [feed('c1', { draining: true, full: [{ ...seated(7), state: 'drain-only' }] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      await assignment.plan(HOST, { reconnect: true, region: US })
      // c2 reports the booking before the host's join: the map still holds only the drain-only seat.
      directory.apply(
        'c2',
        feed('c2', {
          full: undefined,
          seq: 2,
          changes: [{ seq: 2, kind: 'reserve', ...HOST, epoch: 8, generation: 0, reservedBy: 'director', at: now.value }]
        }),
        now.value,
        now.value
      )
      expect(directory.bookingOf(HOST.userId, HOST.relayHostId)).toMatchObject({ cellId: 'c2', epoch: 8 })
      await assignment.plan(HOST, { reconnect: false, region: US })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toHaveLength(1)
    })

    it('counts a host once when it asks again before the new cell reports the booking', async () => {
      const lines: string[] = []
      const { assignment } = setup({
        feeds: [feed('c1', { draining: true, full: [seated(7)] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      await assignment.plan(HOST, { reconnect: true, region: US })
      await assignment.plan(HOST, { reconnect: false, region: US })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toHaveLength(1)
    })

    // Placement memories are clock-free: a host that never reached c2 is not counted again later.
    it('counts a host once per drain, also when it asks again after 30 s', async () => {
      const lines: string[] = []
      const { assignment, directory, now } = setup({
        feeds: [feed('c1', { draining: true, full: [{ ...seated(7), state: 'drain-only' }] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      await assignment.plan(HOST, { reconnect: true, region: US })
      now.value += 31_000
      for (const cellId of ['c1', 'c2']) {
        directory.apply(cellId, feed(cellId, { draining: cellId === 'c1', full: undefined, seq: 1, changes: [] }), now.value, now.value)
      }
      await assignment.plan(HOST, { reconnect: true, region: US })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toHaveLength(1)
    })

    it('counts afresh once the drained cell restarts', async () => {
      const lines: string[] = []
      const { assignment, directory, now } = setup({
        feeds: [feed('c1', { draining: true, full: [seated(7)] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      await assignment.plan(HOST, { reconnect: true, region: US })
      // The host came back to the restarted c1, which drains again.
      directory.apply(
        'c1',
        feed('c1', { incarnation: 'c1-incarnation-2', draining: true, full: [seated(20)] }),
        now.value,
        now.value
      )
      await assignment.plan(HOST, { reconnect: true, region: US })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toHaveLength(2)
    })

    it('marks its pace as the drain’s, on the reserve lane, in the region fallback and in the spill', async () => {
      const { assignment } = setup({
        feeds: [feed('c1', { draining: true, full: [seated(7)] }), feed('c2')],
        reserve: () => ({ outcome: 'intake' })
      })
      await expect(assignment.plan(HOST, { reconnect: true, region: US })).rejects.toMatchObject({ drained: true })
      const plan = await assignment.plan(HOST, { reconnect: true, region: US, regionCorrection: true })
      await expect(plan.kind === 'database' ? plan.regionReserve?.() : null).rejects.toMatchObject({ drained: true })
      await expect(
        plan.kind === 'database' ? plan.reserveSpill?.({ skipOwnRegion: false, rowEpoch: 0 }) : null
      ).rejects.toMatchObject({ drained: true })
    })

    it('leaves every other host as today: no drain count, and a plain pace', async () => {
      const lines: string[] = []
      const { assignment } = setup({ feeds: [feed('c1', { full: [seated(7)] }), feed('c2')], log: (line) => lines.push(line) })
      // A seat on another draining cell than the newest one does not count either.
      const paced = setup({
        feeds: [feed('c1', { full: [seated(7)] }), feed('c2', { draining: true, full: [seated(6)] })],
        reserve: () => ({ outcome: 'intake' })
      })
      expect(await assignment.plan({ ...HOST, relayHostId: 'qrstuvwxyzabcdef' }, { reconnect: false, region: US })).toMatchObject({
        kind: 'answer',
        lane: 'placement'
      })
      await expect(
        paced.assignment.plan(HOST, { reconnect: false, region: US })
      ).rejects.toMatchObject({ drained: false })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toEqual([])
    })

    // The database lane logs orca_relay_sticky_replaced_off_isolated_cell for these; counting both would double the canary's sum.
    it('does not count a placement the database lane makes through its region fallback', async () => {
      const lines: string[] = []
      const { assignment } = setup({
        feeds: [feed('c1', { draining: true, full: [seated(7)] }), feed('c2')],
        log: (line) => lines.push(line)
      })
      const plan = await assignment.plan(HOST, { reconnect: true, region: US, regionCorrection: true })
      await expect(plan.kind === 'database' ? plan.regionReserve?.() : null).resolves.toMatchObject({ cellId: 'c2' })
      expect(events(lines, 'orca_relay_reserve_drain_replaced')).toEqual([])
    })
  })
})
