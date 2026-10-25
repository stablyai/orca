import { describe, expect, it } from 'vitest'
import { CELL_FLAG_DEFAULTS, type CellFlags } from './cell-flags.js'
import { ReserveDeadMan } from './cell-reserve-dead-man.js'
import type { AppliedControlFlags } from './relay-control-flag-channel.js'

const WINDOW_MS = 60_000

function setup() {
  const clock = { value: 1_000_000 }
  const logs: string[] = []
  const deadMan = new ReserveDeadMan('production-gce-c30', () => clock.value, WINDOW_MS, (line) => logs.push(line))
  const events = (name: string) => logs.map((line) => JSON.parse(line)).filter((line) => line.event === name)
  return { clock, logs, deadMan, events }
}

const reserve = (generation: number, flags: Partial<CellFlags> = {}): AppliedControlFlags<CellFlags> => ({
  generation,
  flags: { ...CELL_FLAG_DEFAULTS, ...flags, admitMode: 'reserve' }
})

describe('ReserveDeadMan', () => {
  it('without deadManTripSlots, trips as soon as its window passes', () => {
    const { clock, deadMan, events } = setup()
    expect(deadMan.mode(reserve(1))).toBe('reserve')
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(reserve(1))).toBe('db')
    expect(deadMan.pendingTrip()).toBeNull()
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toHaveLength(1)
  })

  it('with deadManTripSlots, holds reserve until its slot claim lands, then trips and latches', () => {
    const { clock, deadMan, events } = setup()
    const applied = reserve(1, { deadManTripSlots: 2 })
    deadMan.mode(applied)
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(applied)).toBe('reserve')
    expect(deadMan.pendingTrip()).toEqual({ generation: 1, slots: 2 })
    // Held for ten minutes: still reserve, and the held line is written once.
    clock.value += 10 * WINDOW_MS
    expect(deadMan.mode(applied)).toBe('reserve')
    expect(events('orca_relay_cell_reserve_dead_man_held')).toEqual([
      expect.objectContaining({ cellId: 'production-gce-c30', generation: 1, slots: 2 })
    ])
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toEqual([])

    deadMan.permit(1)
    expect(deadMan.mode(applied)).toBe('db')
    expect(deadMan.pendingTrip()).toBeNull()
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toHaveLength(1)
    // Latched for this generation, as an unlimited trip is.
    deadMan.contact()
    expect(deadMan.mode(applied)).toBe('db')
    expect(deadMan.mode(reserve(2, { deadManTripSlots: 2 }))).toBe('reserve')
  })

  it('a slot of zero never lets the cell trip', () => {
    const { clock, deadMan, events } = setup()
    const applied = reserve(1, { deadManTripSlots: 0 })
    deadMan.mode(applied)
    clock.value += 24 * 60 * WINDOW_MS
    expect(deadMan.mode(applied)).toBe('reserve')
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toEqual([])
  })

  // A claim answered after the director came back must not trip the cell later without a slot.
  it('drops a permit for a silence that contact has ended', () => {
    const { clock, deadMan, events } = setup()
    const applied = reserve(1, { deadManTripSlots: 1 })
    deadMan.mode(applied)
    clock.value += WINDOW_MS + 1
    deadMan.mode(applied)
    const held = deadMan.pendingTrip()!
    deadMan.contact()
    deadMan.permit(held.generation)
    expect(deadMan.mode(applied)).toBe('reserve')
    expect(deadMan.pendingTrip()).toBeNull()
    // The next silence is held again and needs a claim of its own.
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(applied)).toBe('reserve')
    expect(deadMan.pendingTrip()).toEqual({ generation: 1, slots: 1 })
    expect(events('orca_relay_cell_reserve_dead_man_held')).toHaveLength(2)
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toEqual([])
  })

  it('drops a permit for an earlier switch generation', () => {
    const { clock, deadMan } = setup()
    deadMan.mode(reserve(1, { deadManTripSlots: 1 }))
    clock.value += WINDOW_MS + 1
    deadMan.mode(reserve(1, { deadManTripSlots: 1 }))
    expect(deadMan.mode(reserve(2, { deadManTripSlots: 1 }))).toBe('reserve')
    deadMan.permit(1)
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(reserve(2, { deadManTripSlots: 1 }))).toBe('reserve')
    expect(deadMan.pendingTrip()).toEqual({ generation: 2, slots: 1 })
  })

  it('a db switch ends a held trip', () => {
    const { clock, deadMan } = setup()
    deadMan.mode(reserve(1, { deadManTripSlots: 1 }))
    clock.value += WINDOW_MS + 1
    deadMan.mode(reserve(1, { deadManTripSlots: 1 }))
    expect(deadMan.mode({ generation: 2, flags: CELL_FLAG_DEFAULTS })).toBe('db')
    expect(deadMan.pendingTrip()).toBeNull()
  })
})
