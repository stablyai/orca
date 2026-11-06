import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { _resetTracerForTests, setActiveSink } from '../../observability/tracer'
import { createStructuredAgentSessionLogRepeats } from './structured-agent-session-log-repeats'

let push: Mock<(record: unknown) => void>
let clock: number

beforeEach(() => {
  push = vi.fn<(record: unknown) => void>()
  clock = 1_000_000
  setActiveSink({ push, flush: () => {}, close: () => {} })
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  _resetTracerForTests()
  vi.restoreAllMocks()
})

describe('a failure that repeats', () => {
  it('tracks a bounded number of repeating entries', () => {
    const repeats = createStructuredAgentSessionLogRepeats({ now: () => clock, maxTracked: 2 })
    expect(repeats.admit('a')).toBe(0)
    expect(repeats.admit('b')).toBe(0)
    expect(repeats.admit('a')).toBeNull()
    expect(repeats.admit('c')).toBe(0)
    expect(repeats.admit('a')).toBe(0)
    expect(repeats.admit('c')).toBeNull()
  })
})
