import { describe, expect, it, vi } from 'vitest'
import type { RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { CellReserveClient } from '../../cell/reservations/cell-reserve-client.js'
import {
  ReserveAssignment,
  ReservePaceError,
  RESERVE_ROW_FLOOR_TTL_MS,
  RESERVE_WRONG_CELL_ROW_READ_MS,
  RESERVE_STARTUP_GATE_MS
} from './reserve-assignment.js'
import { ReservePlacer, type ReserveAttempt } from './reserve-placement.js'
import { ReserveRehome } from './reserve-rehome.js'
import { ShadowSeatDirectory, type SeatFeedCell, type SeatFeedResponse } from '../../cell/seats/shadow-seat-directory.js'

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

  it('re-books a host on a cell that restarted since its seat, and only then answers it', async () => {
    const { assignment, directory, reserved, now } = setup({
      feeds: [feed('c1', { full: [seated(7)] }), feed('c2')]
    })
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
    now.value += RESERVE_ROW_FLOOR_TTL_MS + 1
    for (const response of [feed('c1', { seq: 2, full: [seated(7)] }), feed('c2', { seq: 2 })]) {
      directory.apply(response.cellId, response, now.value, now.value)
    }
    expect(await assignment.plan(HOST, { reconnect: true, region: US })).toMatchObject({
      lane: 'sticky'
    })
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

  })

  describe('rehome on reconnect', () => {
    const ASIA = 'asia-east2' as const
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
  })

  // A half-open seat missed by the booking map must be demoted by the feed, before its 75s silence close.
  it('tells an old reserve seat the booking missed to go once a newer join shows in the feed', () => {
    const { assignment, directory, demoted, now } = setup()
    directory.onOutranked = (seat) => assignment.supersedeOutranked(seat)
    directory.apply('c2', feed('c2', { full: [seated(6, 3_000)] }), now.value, now.value)
    expect(demoted).toEqual([])
    directory.apply('c1', feed('c1', { full: [seated(5, 1_000)] }), now.value, now.value)
    expect(demoted).toEqual([{ cellId: 'c1', epoch: 5, joinedAt: 1_000 }])
  })
})
