import { afterEach, describe, expect, it, vi } from 'vitest'
import { startDiagnosticFetchTimeout } from './diagnostic-fetch-timeout'

describe('diagnostic fetch timeout', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts when the timeout fires', () => {
    vi.useFakeTimers()
    const attempt = startDiagnosticFetchTimeout(5000)

    expect(attempt.signal.aborted).toBe(false)
    expect(attempt.timedOut).toBe(false)

    vi.advanceTimersByTime(5000)

    expect(attempt.signal.aborted).toBe(true)
    expect(attempt.timedOut).toBe(true)
  })

  it('clears the timeout when disposed early', () => {
    vi.useFakeTimers()
    const attempt = startDiagnosticFetchTimeout(5000)

    attempt.dispose()
    expect(attempt.signal.aborted).toBe(true)
    expect(attempt.timedOut).toBe(false)

    vi.advanceTimersByTime(5000)
    expect(attempt.timedOut).toBe(false)
  })
})
