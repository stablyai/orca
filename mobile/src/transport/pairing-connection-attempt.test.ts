import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPairingConnectionAttempt } from './pairing-connection-attempt'

describe('pairing connection attempt cleanup', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('closes the temporary client when the overall pairing timeout fires', () => {
    vi.useFakeTimers()
    const closeClient = vi.fn()

    const attempt = startPairingConnectionAttempt({ timeoutMs: 25_000, closeClient })

    expect(attempt.timedOut).toBe(false)
    vi.advanceTimersByTime(24_999)
    expect(closeClient).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(attempt.timedOut).toBe(true)
    expect(closeClient).toHaveBeenCalledTimes(1)

    attempt.dispose()
    expect(closeClient).toHaveBeenCalledTimes(1)
  })

  it('clears the timeout and closes the temporary client when disposed early', () => {
    vi.useFakeTimers()
    const closeClient = vi.fn()

    const attempt = startPairingConnectionAttempt({ timeoutMs: 25_000, closeClient })
    attempt.dispose()

    expect(attempt.timedOut).toBe(false)
    expect(closeClient).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(25_000)
    expect(attempt.timedOut).toBe(false)
    expect(closeClient).toHaveBeenCalledTimes(1)
  })
})
