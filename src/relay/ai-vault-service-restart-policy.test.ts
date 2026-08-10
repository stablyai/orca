import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayAiVaultRestartPolicy } from './ai-vault-service-restart-policy'

afterEach(() => vi.useRealTimers())

describe('RelayAiVaultRestartPolicy', () => {
  it('opens the circuit after three faults inside the window and closes it after', () => {
    let now = 0
    const policy = new RelayAiVaultRestartPolicy(() => now)

    expect(policy.startError(false)).toBeNull()
    for (let index = 0; index < 3; index += 1) {
      policy.recordFault()
      now += 1_000
    }

    expect(policy.startError(false)?.message).toContain('circuit is open')
    now += 60_000
    expect(policy.startError(false)).toBeNull()
  })

  it('keeps the circuit closed when the faults age out of the window', () => {
    let now = 0
    const policy = new RelayAiVaultRestartPolicy(() => now)

    for (let index = 0; index < 3; index += 1) {
      policy.recordFault()
      now += 30_000
    }

    expect(policy.startError(false)).toBeNull()
  })

  it('lets a forced refresh reopen an open circuit', () => {
    let now = 0
    const policy = new RelayAiVaultRestartPolicy(() => now)

    for (let index = 0; index < 3; index += 1) {
      policy.recordFault()
    }
    expect(policy.startError(false)?.message).toContain('circuit is open')

    expect(policy.startError(true)).toBeNull()
    // The forced start clears the circuit outright, so the next background
    // start is no longer refused either.
    expect(policy.startError(false)).toBeNull()
  })

  it('backs off further with each fault and keeps one pending restart', () => {
    vi.useFakeTimers()
    const policy = new RelayAiVaultRestartPolicy()
    const restart = vi.fn()

    policy.recordFault()
    policy.scheduleRestart(restart)
    vi.advanceTimersByTime(250)
    expect(restart).toHaveBeenCalledTimes(1)

    policy.recordFault()
    policy.scheduleRestart(restart)
    policy.recordFault()
    policy.scheduleRestart(restart)
    vi.advanceTimersByTime(250)
    expect(restart).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(5_000)
    expect(restart).toHaveBeenCalledTimes(2)
  })

  it('cancels the pending restart on dispose', () => {
    vi.useFakeTimers()
    const policy = new RelayAiVaultRestartPolicy()
    const restart = vi.fn()

    policy.recordFault()
    policy.scheduleRestart(restart)
    policy.dispose()
    vi.advanceTimersByTime(10_000)

    expect(restart).not.toHaveBeenCalled()
    expect(policy.restartScheduled).toBe(false)
  })
})
