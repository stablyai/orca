import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestProgramRepaint, restoreFromReattachedReadyScreen } from './reattached-ready-screen'

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
      hasOutputSinceReattach: () => outputAt !== null,
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

  it('never settles on a retained screen the agent does not repaint', async () => {
    vi.useFakeTimers()
    const applyIdle = vi.fn()
    const requestRepaint = vi.fn()
    restoreFromReattachedReadyScreen({
      agent: 'hermes',
      readScreen: () => HERMES_READY,
      readOutputClockAt: () => null,
      hasOutputSinceReattach: () => false,
      requestRepaint,
      isCurrent: () => true,
      applyIdle
    })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(applyIdle).not.toHaveBeenCalled()
    expect(requestRepaint).toHaveBeenCalledTimes(1)
  })

  it('repaints by resizing one row smaller and back', async () => {
    vi.useFakeTimers()
    let size = { cols: 120, rows: 40 }
    const resizes: [number, number][] = []
    requestProgramRepaint({
      getSize: () => size,
      resize: (cols, rows) => {
        resizes.push([cols, rows])
        size = { cols, rows }
        return true
      }
    })
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([
      [120, 39],
      [120, 40]
    ])
  })
})
