import { describe, expect, it, vi } from 'vitest'
import {
  measureTerminalViewportOnce,
  type TerminalViewportOnceArgs
} from './mobile-terminal-first-subscribe-viewport'

const PHONE = { cols: 55, rows: 47 }

function onceArgs(overrides: Partial<TerminalViewportOnceArgs> = {}): TerminalViewportOnceArgs {
  return {
    handle: 'term-1',
    ref: { measureFitDimensions: vi.fn(async () => PHONE) },
    viewportRef: { current: null },
    viewportMeasuredRef: { current: false },
    terminalFrameHeightRef: { current: 751 },
    onMeasured: vi.fn(),
    ...overrides
  }
}

describe('measureTerminalViewportOnce', () => {
  it('stores the measured dims against the frame height', async () => {
    const args = onceArgs()
    await measureTerminalViewportOnce(args)
    expect(args.ref?.measureFitDimensions).toHaveBeenCalledWith(751)
    expect(args.viewportRef.current).toEqual(PHONE)
    expect(args.viewportMeasuredRef.current).toBe(true)
    expect(args.onMeasured).toHaveBeenCalledWith('term-1', PHONE, 751)
  })

  it('does nothing once the route has a viewport', async () => {
    const args = onceArgs({ viewportMeasuredRef: { current: true } })
    await measureTerminalViewportOnce(args)
    expect(args.ref?.measureFitDimensions).not.toHaveBeenCalled()
  })

  it('leaves the viewport unmeasured when the document cannot measure', async () => {
    const args = onceArgs({ ref: { measureFitDimensions: vi.fn(async () => null) } })
    await measureTerminalViewportOnce(args)
    expect(args.viewportMeasuredRef.current).toBe(false)
    expect(args.viewportRef.current).toBe(null)
  })
})
