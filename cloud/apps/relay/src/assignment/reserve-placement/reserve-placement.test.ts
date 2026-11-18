import { describe, expect, it } from 'vitest'
import { ReservePlacer, type PlacementCell } from './reserve-placement.js'

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

  it('counts its own bookings against the seat estimate until the next poll', () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const cells = [cell('c1', { ceiling: 2, intakePerSec: 1_000 })]
    placer.pick(cells, 'us-central1', new Set())
    now.value = 1_000
    cells[0]!.polledAt = 1_000
    void placer.place({ cells, region: 'us-central1', epoch: 1, reserve: async () => ({ outcome: 'ok' }) })
    void placer.place({ cells, region: 'us-central1', epoch: 1, reserve: async () => ({ outcome: 'ok' }) })
    expect(placer.pick(cells, 'us-central1', new Set())).toBeNull()
  })

})

describe('reserve placer under concurrent placements', () => {
  it('takes back only its own booking when a refusal lands after a later call was counted', async () => {
    const now = { value: 0 }
    const placer = warmPlacer(now)
    const target = cell('c1', { intakeTokens: 20 })
    placer.pick([target], 'us-central1', new Set())
    now.value = 1_000
    target.polledAt = now.value
    let refuseFirst: (() => void) | undefined
    const first = placer.place({
      cells: [target],
      region: 'us-central1',
      epoch: 4,
      reserve: () => new Promise((resolve) => (refuseFirst = () => resolve({ outcome: 'full' })))
    })
    now.value = 1_005
    const second = await placer.place({
      cells: [target],
      region: 'us-central1',
      epoch: 7,
      reserve: async () => ({ outcome: 'ok' })
    })
    expect(second).toMatchObject({ kind: 'placed' })
    refuseFirst!()
    await first
    // The cell's poll sent at 1,003 covers neither; only the second (counted at 1,005) is left.
    expect(placer.load({ ...target, polledAt: 1_003 })).toBe(1)
  })
})
