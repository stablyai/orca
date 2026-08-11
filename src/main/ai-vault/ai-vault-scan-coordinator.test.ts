import { describe, expect, it, vi } from 'vitest'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'

const EMPTY_RESULT = { sessions: [], issues: [], scannedAt: '2026-07-27T00:00:00.000Z' }

describe('AiVaultScanCoordinator', () => {
  it('keeps a shared scan alive when only one caller cancels', async () => {
    const coordinator = new AiVaultScanCoordinator()
    let resolveScan: ((result: typeof EMPTY_RESULT) => void) | undefined
    let sharedSignal: AbortSignal | undefined
    const start = vi.fn(
      (signal: AbortSignal) =>
        new Promise<typeof EMPTY_RESULT>((resolve) => {
          sharedSignal = signal
          resolveScan = resolve
        })
    )
    const controller = new AbortController()
    const first = coordinator.run({ key: 'scope', signal: controller.signal, start })
    const second = coordinator.run({ key: 'scope', start })
    await Promise.resolve()

    controller.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(sharedSignal?.aborted).toBe(false)
    resolveScan?.(EMPTY_RESULT)
    await expect(second).resolves.toEqual(EMPTY_RESULT)
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('preempts a non-forced scan and re-joins its caller onto the forced scan', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const signals: AbortSignal[] = []
    let resolveForced: ((result: typeof EMPTY_RESULT) => void) | undefined
    const start = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<typeof EMPTY_RESULT>((resolve) => {
        if (signals.length === 1) {
          signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true })
        } else {
          resolveForced = resolve
        }
      })
    })
    const first = coordinator.run({ key: 'scope', start })
    await Promise.resolve()

    const forced = coordinator.run({ key: 'scope', force: true, start })
    const joined = coordinator.run({ key: 'scope', force: true, start })
    await Promise.resolve()

    expect(signals[0]?.aborted).toBe(true)
    expect(start).toHaveBeenCalledTimes(2)
    resolveForced?.(EMPTY_RESULT)
    // The first caller never asked to cancel, so someone else's Refresh must
    // hand it the replacement's result instead of a spurious cancellation.
    await expect(Promise.all([first, forced, joined])).resolves.toEqual([
      EMPTY_RESULT,
      EMPTY_RESULT,
      EMPTY_RESULT
    ])
  })

  it('keeps coalescing forced callers onto a forced scan that is still fresh', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new AiVaultScanCoordinator()
      let resolveScan: ((result: typeof EMPTY_RESULT) => void) | undefined
      const start = vi.fn(
        () =>
          new Promise<typeof EMPTY_RESULT>((resolve) => {
            resolveScan = resolve
          })
      )
      const first = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      vi.advanceTimersByTime(4_999)
      const second = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      expect(start).toHaveBeenCalledTimes(1)
      resolveScan?.(EMPTY_RESULT)
      // Both callers settle off the single shared scan instead of preempting it.
      await expect(Promise.all([first, second])).resolves.toEqual([EMPTY_RESULT, EMPTY_RESULT])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a forced refresh preempt a forced scan that hung past the coalescing window', async () => {
    vi.useFakeTimers()
    try {
      const coordinator = new AiVaultScanCoordinator()
      const signals: AbortSignal[] = []
      let resolveSecond: ((result: typeof EMPTY_RESULT) => void) | undefined
      const start = vi.fn((signal: AbortSignal) => {
        signals.push(signal)
        return new Promise<typeof EMPTY_RESULT>((resolve) => {
          if (signals.length > 1) {
            resolveSecond = resolve
          }
        })
      })
      const stuck = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      vi.advanceTimersByTime(5_000)
      const retry = coordinator.run({ key: 'scope', force: true, start })
      await Promise.resolve()

      expect(signals[0]?.aborted).toBe(true)
      expect(start).toHaveBeenCalledTimes(2)
      resolveSecond?.(EMPTY_RESULT)
      // The caller stranded on the hung scan rides the replacement out rather
      // than being told its own refresh was cancelled.
      await expect(Promise.all([stuck, retry])).resolves.toEqual([EMPTY_RESULT, EMPTY_RESULT])
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts a fresh scan after every waiter cancels', async () => {
    const coordinator = new AiVaultScanCoordinator()
    const signals: AbortSignal[] = []
    const start = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      if (signals.length > 1) {
        return Promise.resolve(EMPTY_RESULT)
      }
      return new Promise<typeof EMPTY_RESULT>((resolve) => {
        signal.addEventListener('abort', () => resolve(EMPTY_RESULT), { once: true })
      })
    })
    const controller = new AbortController()
    const first = coordinator.run({ key: 'scope', signal: controller.signal, start })
    await Promise.resolve()
    controller.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })

    const second = coordinator.run({ key: 'scope', start })

    await expect(second).resolves.toEqual(EMPTY_RESULT)
    expect(start).toHaveBeenCalledTimes(2)
    expect(signals[0]?.aborted).toBe(true)
  })
})
