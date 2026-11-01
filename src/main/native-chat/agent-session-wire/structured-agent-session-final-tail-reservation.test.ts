import { describe, expect, it } from 'vitest'
import { StructuredAgentSessionFinalTailReservation } from './structured-agent-session-final-tail-reservation'

describe('finalized provider tail reservations', () => {
  it('admits a large captured tail while bounding operations and releasing each admission once', () => {
    const reservation = new StructuredAgentSessionFinalTailReservation()
    const release = reservation.reserve(16 * 1024 * 1024)
    expect(release).not.toBeNull()
    const rest = Array.from({ length: 511 }, () => reservation.reserve(1))
    expect(rest.every(Boolean)).toBe(true)
    expect(reservation.reserve(0)).toBeNull()
    release?.()
    release?.()
    expect(reservation.reserve(16 * 1024 * 1024)).not.toBeNull()
    expect(reservation.reserve(0)).toBeNull()
  })
})
