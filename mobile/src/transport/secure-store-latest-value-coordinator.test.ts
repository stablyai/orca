import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SecureStoreLatestValueCoordinator } from './secure-store-latest-value-coordinator'

describe('secure-store latest-value coordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('retains and retries the latest generation when stale-write repair fails', async () => {
    let finishFirst!: () => void
    const persisted: Array<string | null> = []
    let latestRepairAttempts = 0
    const coordinator = new SecureStoreLatestValueCoordinator(async (_hostId, desired) => {
      const value = desired?.value ?? null
      if (value === 'first' && !finishFirst) {
        await new Promise<void>((resolve) => {
          finishFirst = resolve
        })
      }
      if (value === 'latest' && persisted.includes('first') && latestRepairAttempts++ === 0) {
        throw new Error('transient keychain failure')
      }
      persisted.push(value)
    })

    const first = coordinator.write('host-1', 'first')
    await vi.waitFor(() => expect(finishFirst).toBeTypeOf('function'))
    await coordinator.write('host-1', 'latest')
    finishFirst()
    await expect(first).rejects.toThrow(/keychain failure/)

    expect(coordinator.pending('host-1')).toEqual({ present: true, value: 'latest' })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(persisted.at(-1)).toBe('latest')
    expect(coordinator.pending('host-1')).toEqual({ present: false, value: null })
  })
})
