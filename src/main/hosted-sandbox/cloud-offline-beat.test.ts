import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOwedWorkBeat } from './cloud-offline-beat'

const T0 = 1_800_000_000_000

describe('owed-work beat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('stays idle with nothing owed, and backs off while passes change nothing', async () => {
    let due: number | null = null
    const pass = vi.fn(async () => {})
    const beat = createOwedWorkBeat({
      nextDueAt: () => due,
      pass,
      baseMs: 1_000,
      maxBackoffSteps: 2
    })
    beat.poke()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pass).not.toHaveBeenCalled()

    due = T0
    beat.poke()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pass).toHaveBeenCalledTimes(1)
    // Unchanged after that pass: the next waits 2 s, then 4 s (the cap).
    await vi.advanceTimersByTimeAsync(1_999)
    expect(pass).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(pass).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(pass).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(pass).toHaveBeenCalledTimes(4)

    due = null
    await vi.advanceTimersByTimeAsync(4_000)
    const settled = pass.mock.calls.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pass).toHaveBeenCalledTimes(settled)
    beat.dispose()
  })

  it('waits for a later due attempt and stops on dispose', async () => {
    const pass = vi.fn(async () => {})
    const beat = createOwedWorkBeat({
      nextDueAt: () => T0 + 10_000,
      pass,
      baseMs: 1_000,
      maxBackoffSteps: 2
    })
    beat.poke()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(pass).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(pass).toHaveBeenCalledTimes(1)
    beat.dispose()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(pass).toHaveBeenCalledTimes(1)
  })
})
