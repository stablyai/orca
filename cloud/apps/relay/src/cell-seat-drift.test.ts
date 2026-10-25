import { describe, expect, it } from 'vitest'
import { CELL_SEAT_DRIFT_SWEEP_MS, SeatDriftConfirmation, unbackedSeatReason } from './cell-seat-drift.js'

describe('cell seat drift', () => {
  const seat = { epoch: 10, generation: 3 }
  const live = { state: 'active', socket: {}, assignmentEpoch: 10, generation: 3 }

  it('names why no live session backs a seat, and nothing when one does', () => {
    expect(unbackedSeatReason(seat, live)).toBeNull()
    expect(unbackedSeatReason(seat, { ...live, state: 'drain-only' })).toBeNull()
    expect(unbackedSeatReason(seat, null)).toBe('no-session')
    expect(unbackedSeatReason(seat, { ...live, state: 'closed' })).toBe('closed')
    expect(unbackedSeatReason(seat, { ...live, socket: null })).toBe('no-socket')
    expect(unbackedSeatReason(seat, { ...live, assignmentEpoch: 11 })).toBe('epoch')
    expect(unbackedSeatReason(seat, { ...live, generation: 1 })).toBe('generation')
  })

  it('confirms only what two sweeps in a row found, at most once per sweep interval', () => {
    const drift = new SeatDriftConfirmation()
    expect(drift.due(0)).toBe(true)
    expect(drift.confirm(['a', 'b'])).toEqual(new Set())
    expect(drift.due(CELL_SEAT_DRIFT_SWEEP_MS - 1)).toBe(false)
    expect(drift.due(CELL_SEAT_DRIFT_SWEEP_MS)).toBe(true)
    expect(drift.confirm(['b', 'c'])).toEqual(new Set(['b']))
    expect(drift.confirm(['c'])).toEqual(new Set(['c']))
  })
})
