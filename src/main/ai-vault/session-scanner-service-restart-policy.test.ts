import { afterEach, describe, expect, it, vi } from 'vitest'
import { AiVaultServiceRestartPolicy } from './session-scanner-service-restart-policy'

afterEach(() => vi.useRealTimers())

describe('AiVaultServiceRestartPolicy', () => {
  it('keeps one pending restart when faults overlap', () => {
    vi.useFakeTimers()
    const policy = new AiVaultServiceRestartPolicy()
    const restart = vi.fn()

    policy.recordFault(restart)
    policy.recordFault(restart)
    vi.advanceTimersByTime(10_000)

    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('cancels the pending restart on dispose after overlapping faults', () => {
    vi.useFakeTimers()
    const policy = new AiVaultServiceRestartPolicy()
    const restart = vi.fn()

    policy.recordFault(restart)
    policy.recordFault(restart)
    policy.dispose()
    vi.advanceTimersByTime(10_000)

    expect(restart).not.toHaveBeenCalled()
    expect(policy.restartScheduled).toBe(false)
  })

  it('clears the pending backoff and fault history for a forced retry', () => {
    vi.useFakeTimers()
    const policy = new AiVaultServiceRestartPolicy()
    const restart = vi.fn()

    policy.recordFault(restart)
    policy.clearCircuit()
    vi.advanceTimersByTime(10_000)

    expect(restart).not.toHaveBeenCalled()
    policy.recordFault(restart)
    policy.recordFault(restart)
    expect(policy.startError()).toBeNull()
    policy.dispose()
  })

  it('opens the circuit after three faults inside the window', () => {
    let now = 0
    const policy = new AiVaultServiceRestartPolicy(() => now)

    expect(policy.startError()).toBeNull()
    for (let index = 0; index < 3; index += 1) {
      policy.recordFault(() => undefined)
      now += 1_000
    }

    expect(policy.startError()?.message).toContain('circuit is open')
    now += 60_000
    expect(policy.startError()).toBeNull()
    policy.dispose()
  })
})
