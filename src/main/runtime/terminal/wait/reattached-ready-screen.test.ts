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
    const readScreen = vi.fn(() => HERMES_READY)
    restoreFromReattachedReadyScreen({
      agent: 'hermes',
      readScreen,
      readOutputClockAt: () => outputAt,
      hasPaintedSinceReattach: () => outputAt !== null,
      requestRepaint,
      isCurrent: () => true,
      applyIdle
    })
    expect(applyIdle).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(15_000)
    expect(requestRepaint).toHaveBeenCalledTimes(1)
    expect(applyIdle).not.toHaveBeenCalled()
    expect(readScreen).not.toHaveBeenCalled()

    outputAt = Date.now()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(applyIdle).toHaveBeenCalledTimes(1)
    expect(requestRepaint).toHaveBeenCalledTimes(1)
  })
})
