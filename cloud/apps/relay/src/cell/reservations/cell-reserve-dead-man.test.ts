import { describe, expect, it } from 'vitest'
import { CELL_FLAG_DEFAULTS, type CellFlags } from '../control-flags/cell-flags.js'
import { ReserveDeadMan } from './cell-reserve-dead-man.js'
import type { AppliedControlFlags } from '../control-flags/relay-control-flag-channel.js'

const WINDOW_MS = 60_000

function setup(bootGraceMs?: number) {
  const clock = { value: 1_000_000 }
  const logs: string[] = []
  const deadMan = new ReserveDeadMan(
    'production-gce-c30',
    () => clock.value,
    WINDOW_MS,
    (line) => logs.push(line),
    bootGraceMs
  )
  const events = (name: string) =>
    logs.map((line) => JSON.parse(line)).filter((line) => line.event === name)
  return { clock, logs, deadMan, events }
}

const reserve = (
  generation: number,
  flags: Partial<CellFlags> = {}
): AppliedControlFlags<CellFlags> => ({
  generation,
  flags: { ...CELL_FLAG_DEFAULTS, ...flags, admitMode: 'reserve' }
})

describe('ReserveDeadMan', () => {

  it('gives a fresh process the boot grace until its first contact, then the plain window', () => {
    const grace = 3 * WINDOW_MS
    const { clock, deadMan, events } = setup(grace)
    expect(deadMan.mode(reserve(1))).toBe('reserve')
    // No director has reached the new process yet: past its window, still inside the grace.
    clock.value += WINDOW_MS + grace
    expect(deadMan.mode(reserve(1))).toBe('reserve')
    deadMan.contact()
    // After the first contact, silence trips on the plain window again.
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(reserve(1))).toBe('db')
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toHaveLength(1)
  })

  it('still trips a fresh process that never hears from a placing director', () => {
    const grace = 3 * WINDOW_MS
    const { clock, deadMan, events } = setup(grace)
    expect(deadMan.mode(reserve(1))).toBe('reserve')
    clock.value += WINDOW_MS + grace + 1
    expect(deadMan.mode(reserve(1))).toBe('db')
    expect(events('orca_relay_cell_reserve_dead_man_tripped')).toEqual([
      expect.objectContaining({ silentMs: WINDOW_MS + grace + 1 })
    ])
  })

  it('keeps the plain window for a later reserve write once a director has been in touch', () => {
    const { clock, deadMan } = setup(3 * WINDOW_MS)
    deadMan.mode(reserve(1))
    deadMan.contact()
    expect(deadMan.mode(reserve(2))).toBe('reserve')
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(reserve(2))).toBe('db')
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
    clock.value += WINDOW_MS + 1
    expect(deadMan.mode(reserve(2, { deadManTripSlots: 1 }))).toBe('reserve')
    expect(deadMan.pendingTrip()).toEqual({ generation: 2, slots: 1 })
    deadMan.permit(1)
    expect(deadMan.mode(reserve(2, { deadManTripSlots: 1 }))).toBe('reserve')
    expect(deadMan.pendingTrip()).toEqual({ generation: 2, slots: 1 })
  })

})
