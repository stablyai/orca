import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduledMessageTickLoop } from './scheduled-message-tick-loop'

const INTERVAL_MS = 30_000

describe('ScheduledMessageTickLoop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('keeps scanning after a pass throws', async () => {
    // This loop is the only thing that revisits a due message. A single throw —
    // a snapshot send into a window that is being destroyed, a store read racing
    // teardown — used to end scheduling silently for the rest of the session.
    const warn = vi.fn()
    let passes = 0
    const loop = new ScheduledMessageTickLoop(
      () => {
        passes += 1
        return passes === 1 ? Promise.reject(new Error('window destroyed')) : Promise.resolve()
      },
      INTERVAL_MS,
      { warn }
    )

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(passes).toBe(1)
    expect(warn).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)
    expect(passes).toBe(3)
    loop.dispose()
  })

  it('stops scanning once disposed', async () => {
    const passes = vi.fn(() => Promise.resolve())
    const loop = new ScheduledMessageTickLoop(passes, INTERVAL_MS, { warn: vi.fn() })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    loop.dispose()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(passes).toHaveBeenCalledOnce()
  })

  it('does not re-arm when disposal lands while a pass is in flight', async () => {
    // Quit runs while a delivery is awaiting the send guard; the pass resolves
    // afterwards and must not schedule the next scan into a torn-down process.
    let release = (): void => {}
    const passes = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const loop = new ScheduledMessageTickLoop(passes, INTERVAL_MS, { warn: vi.fn() })

    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    loop.dispose()
    release()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)

    expect(passes).toHaveBeenCalledOnce()
  })
})
