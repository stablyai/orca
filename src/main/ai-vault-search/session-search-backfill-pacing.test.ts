import { afterEach, describe, expect, it, vi } from 'vitest'

// Why: a saturated host puts the backfill into its 15 s back-off; the test
// pins the load so the pause is the long one, then proves an abort ends it.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, loadavg: (): number[] => [1000, 1000, 1000] }
})
import type * as NodeOs from 'node:os'
import { pauseBackfill } from './session-search-backfill-pacing'

afterEach(() => {
  vi.useRealTimers()
})

describe('pauseBackfill', () => {
  it('ends the long back-off as soon as the backfill is aborted', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let settled = false
    const pause = pauseBackfill(controller.signal).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled).toBe(false)

    controller.abort()
    await pause
    expect(settled).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves at once when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(pauseBackfill(controller.signal)).resolves.toBeUndefined()
  })
})
