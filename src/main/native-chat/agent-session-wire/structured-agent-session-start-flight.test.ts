import { describe, expect, it } from 'vitest'
import { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'

describe('start flight child retention', () => {
  it.each([10, 100])('retires a flight after %i duplicate publications', (count) => {
    const flights = new StructuredAgentSessionStartFlights()
    const flight = {
      attemptId: 'start',
      abort: () => {},
      outcome: Promise.resolve({ ok: true as const })
    }
    flights.register('chat', flight)
    const child = { generation: 'child', fence: 1 }
    for (let n = 0; n < count; n++) {
      flights.published('chat', { ...child })
    }
    expect(flights.get('chat')?.children).toEqual([child])
    expect(flights.ownsChild('chat', child)).toBe(true)
    const successor = { ...child, fence: 2 }
    flights.published('chat', successor)
    flights.published('chat', { ...successor })
    expect(flights.get('chat')?.children).toEqual([child, successor])
    flights.end('chat', flight.attemptId)
    flights.published('chat', child)
    expect(flights.has('chat')).toBe(false)
    expect(flights.ownsChild('chat', child)).toBe(false)
  })
})
