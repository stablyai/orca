import { afterEach, describe, expect, it, vi } from 'vitest'
import { restoreFromReattachedReadyScreen } from './reattached-ready-screen'

const HERMES_READY = { lines: ['─ ready │ 3s', '❯ Ask me anything…'], alternateScreen: false }

describe('a reattached agent ready screen', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for the agent to repaint a retained ready screen, asking it to once', async () => {
    vi.useFakeTimers()
    let outputAt: number | null = null
    const applyIdle = vi.fn()
    const requestRepaint = vi.fn()
    restoreFromReattachedReadyScreen({
      agent: 'hermes',
      readScreen: () => HERMES_READY,
      readOutputClockAt: () => outputAt,
      hasPaintedSinceReattach: () => outputAt !== null,
      requestRepaint,
      isCurrent: () => true,
      applyIdle
    })
    expect(applyIdle).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1_000)
    expect(requestRepaint).toHaveBeenCalledTimes(1)
    expect(applyIdle).not.toHaveBeenCalled()

    outputAt = Date.now()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(applyIdle).toHaveBeenCalledTimes(1)
    expect(requestRepaint).toHaveBeenCalledTimes(1)
  })

  it('asks a quiet agent to repaint whatever frame it left, and never settles on that frame', async () => {
    vi.useFakeTimers()
    const applyIdle = vi.fn()
    const requestRepaint = vi.fn()
    const readScreen = vi.fn(() => HERMES_READY)
    restoreFromReattachedReadyScreen({
      agent: 'hermes',
      readScreen,
      readOutputClockAt: () => null,
      hasPaintedSinceReattach: () => false,
      requestRepaint,
      isCurrent: () => true,
      applyIdle
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(applyIdle).not.toHaveBeenCalled()
    expect(requestRepaint).toHaveBeenCalledTimes(1)
    expect(readScreen).not.toHaveBeenCalled()
  })
})
