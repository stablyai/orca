import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionRepaintNudge } from '../session-repaint-nudge'

describe.skipIf(process.platform === 'win32')('session repaint nudge', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resizes the PTY one row smaller and back, once at a time', async () => {
    vi.useFakeTimers()
    const nudge = new SessionRepaintNudge()
    const resizes: [number, number][] = []
    const request = () =>
      nudge.request(
        () => ({ cols: 120, rows: 40 }),
        (cols, rows) => resizes.push([cols, rows]),
        () => true
      )
    request()
    request()
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([
      [120, 39],
      [120, 40]
    ])
  })

  it('leaves the grid to a real resize that lands meanwhile', async () => {
    vi.useFakeTimers()
    const nudge = new SessionRepaintNudge()
    let grid = { cols: 120, rows: 40 }
    const resizes: [number, number][] = []
    nudge.request(
      () => grid,
      (cols, rows) => resizes.push([cols, rows]),
      () => true
    )
    grid = { cols: 100, rows: 30 }
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([[120, 39]])
  })

  it('starts a fresh nudge for a request after a real resize, and the old one stands down', async () => {
    vi.useFakeTimers()
    const nudge = new SessionRepaintNudge()
    let grid = { cols: 120, rows: 40 }
    const resizes: [number, number][] = []
    const request = () =>
      nudge.request(
        () => grid,
        (cols, rows) => resizes.push([cols, rows]),
        () => true
      )
    request()
    grid = { cols: 120, rows: 50 }
    request()
    await vi.advanceTimersByTimeAsync(250)
    expect(resizes).toEqual([
      [120, 39],
      [120, 49],
      [120, 50]
    ])
  })
})
