import { describe, expect, it } from 'vitest'
import {
  demotionLosers,
  demotionWinner,
  mintEpoch,
  ReservePlacer,
  type PlacementCell
} from './reserve-placement.js'

function cell(cellId: string, overrides: Partial<PlacementCell> = {}): PlacementCell {
  return {
    cellId,
    region: 'us-central1',
    reserve: true,
    general: true,
    draining: false,
    polledAt: 0,
    seats: 0,
    bookings: 0,
    ceiling: 100,
    intakePerSec: 50,
    intakeTokens: 20,
    ...overrides
  }
}

// Estimates start empty after a restart; a second of refill gives each cell its share.
function warmPlacer(now: { value: number }, random = () => 0.3) {
  const placer = new ReservePlacer(() => now.value, random)
  return placer
}

describe('reserve placer', () => {
  it('places on the first cell that answers ok and counts one call', async () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('c1'), cell('c2')]
    placer.pick(cells, 'us-central1', new Set())
    now.value = 1_000
    cells.forEach((entry) => (entry.polledAt = now.value))
    const result = await placer.place({
      cells,
      region: 'us-central1',
      epoch: 4,
      reserve: async () => ({ outcome: 'ok' })
    })
    expect(result).toMatchObject({ kind: 'placed', epoch: 4, calls: 1 })
  })

  it('stops after three refusals and falls back to the database pool when it has cells', async () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('c1'), cell('c2'), cell('c3'), cell('c4'), cell('db1', { reserve: false })]
    placer.pick(cells, 'us-central1', new Set())
    now.value = 1_000
    cells.forEach((entry) => (entry.polledAt = now.value))
    const asked: string[] = []
    const result = await placer.place({
      cells,
      region: 'us-central1',
      epoch: 2,
      reserve: async (cellId) => {
        asked.push(cellId)
        return { outcome: 'full' }
      }
    })
    expect(asked).toHaveLength(3)
    expect(new Set(asked).size).toBe(3)
    expect(result).toEqual({ kind: 'database', calls: 3 })
  })

  it('re-mints above a seated-newer answer', async () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('c1'), cell('c2')]
    placer.pick(cells, 'us-central1', new Set())
    now.value = 1_000
    cells.forEach((entry) => (entry.polledAt = now.value))
    const epochs: number[] = []
    const result = await placer.place({
      cells,
      region: 'us-central1',
      epoch: 3,
      reserve: async (_cellId, epoch) => {
        epochs.push(epoch)
        return epochs.length === 1 ? { outcome: 'seated-newer', epoch: 7 } : { outcome: 'ok' }
      }
    })
    expect(epochs).toEqual([3, 8])
    expect(result).toMatchObject({ kind: 'placed', epoch: 8 })
  })

  it('paces with a bounded Retry-After when reserve cells have seats but no budget', () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('c1', { intakePerSec: 2 })]
    expect(placer.pick(cells, 'us-central1', new Set())).toBeNull()
    expect(placer.fallback(cells, 'us-central1', 0)).toEqual({ kind: 'pace', retryAfterSeconds: 3, calls: 0 })
  })

  it('never offers a stale, draining, non-general, full or other-region cell', () => {
    const now = { value: 10_000 }
    const placer = warmPlacer(now)
    const cells = [
      cell('stale', { polledAt: 6_000 }),
      cell('draining', { draining: true, polledAt: 10_000 }),
      cell('isolated', { general: false, polledAt: 10_000 }),
      cell('full', { seats: 99, bookings: 1, polledAt: 10_000 }),
      cell('asia-east2', { region: 'asia-east2', polledAt: 10_000 }),
      cell('db', { reserve: false, polledAt: 10_000 }),
      cell('old', { ceiling: undefined, polledAt: 10_000 })
    ]
    placer.pick(cells, 'us-central1', new Set())
    now.value = 11_000
    expect(placer.pick(cells, 'us-central1', new Set())).toBeNull()
  })

  it('counts its own bookings against the seat estimate until the next poll', () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('c1', { ceiling: 2, intakePerSec: 1_000 })]
    placer.pick(cells, 'us-central1', new Set())
    now.value = 1_000
    cells[0]!.polledAt = 1_000
    // Two of this director's own bookings fill the estimated ceiling.
    void placer.place({ cells, region: 'us-central1', epoch: 1, reserve: async () => ({ outcome: 'ok' }) })
    void placer.place({ cells, region: 'us-central1', epoch: 1, reserve: async () => ({ outcome: 'ok' }) })
    expect(placer.pick(cells, 'us-central1', new Set())).toBeNull()
  })

  it('weights the reserve pool by free seats and gives it nothing while a database cell is unknown', () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('r1', { seats: 50 }), cell('d1', { reserve: false, seats: 50 })]
    expect(placer.reservePoolShare(cells, 'us-central1')).toBeCloseTo(0.5)
    cells.push(cell('d2', { reserve: false, ceiling: undefined }))
    expect(placer.reservePoolShare(cells, 'us-central1')).toBe(0)
  })
})

describe('epoch mint and demotion winner', () => {
  it('mints one above every known epoch', () => {
    expect(mintEpoch([])).toBe(1)
    expect(mintEpoch([3, 9, 4])).toBe(10)
  })

  it('picks the newest join, then the higher epoch, then the lower cell id', () => {
    expect(
      demotionWinner([
        { cellId: 'b', epoch: 2, joinedAt: 10 },
        { cellId: 'a', epoch: 1, joinedAt: 20 }
      ])?.cellId
    ).toBe('a')
    expect(
      demotionWinner([
        { cellId: 'a', epoch: 2, joinedAt: 10 },
        { cellId: 'b', epoch: 3, joinedAt: 10 }
      ])?.cellId
    ).toBe('b')
    const tie = [
      { cellId: 'b', epoch: 3, joinedAt: 10 },
      { cellId: 'a', epoch: 3, joinedAt: 10 }
    ]
    expect(demotionWinner(tie)?.cellId).toBe('a')
    expect(demotionWinner([...tie].reverse())?.cellId).toBe('a')
  })

  it('demotes a seat once it has been outranked for the grace period, never the top one', () => {
    const seats = [
      { cellId: 'a', epoch: 3, joinedAt: 0 },
      { cellId: 'b', epoch: 5, joinedAt: 4_000 },
      { cellId: 'c', epoch: 6, joinedAt: 9_000 }
    ]
    expect(demotionLosers(seats, 13_999, 10_000)).toEqual([])
    expect(demotionLosers(seats, 14_000, 10_000).map((seat) => seat.cellId)).toEqual(['a'])
    // A host flapping onto a third cell does not keep the first seat alive.
    expect(demotionLosers(seats, 19_000, 10_000).map((seat) => seat.cellId)).toEqual(['a', 'b'])
    expect(demotionLosers([seats[0]!], 99_000, 10_000)).toEqual([])
  })
})
