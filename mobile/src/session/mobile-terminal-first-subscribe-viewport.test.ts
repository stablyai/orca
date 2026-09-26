import { describe, expect, it, vi } from 'vitest'
import {
  deferFirstSubscribeUntilViewportMeasured,
  measureTerminalViewportOnce,
  type FirstSubscribeViewportGateArgs,
  type TerminalViewportOnceArgs
} from './mobile-terminal-first-subscribe-viewport'

const PHONE = { cols: 55, rows: 47 }

function onceArgs(overrides: Partial<TerminalViewportOnceArgs> = {}): TerminalViewportOnceArgs {
  return {
    handle: 'term-1',
    ref: {
      init: vi.fn(),
      awaitReady: vi.fn(async () => {}),
      measureFitDimensions: vi.fn(async () => PHONE)
    },
    documentHasTerminal: true,
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
    const args = onceArgs({
      ref: {
        init: vi.fn(),
        awaitReady: vi.fn(async () => {}),
        measureFitDimensions: vi.fn(async () => null)
      }
    })
    await measureTerminalViewportOnce(args)
    expect(args.viewportMeasuredRef.current).toBe(false)
    expect(args.viewportRef.current).toBe(null)
  })
})

describe('measureTerminalViewportOnce on a fresh document', () => {
  it('opens an empty terminal and waits for it before measuring, so cell metrics exist', async () => {
    const order: string[] = []
    const args = onceArgs({
      documentHasTerminal: false,
      ref: {
        init: vi.fn((cols: number, rows: number, data?: string) => {
          order.push(`init ${cols}x${rows} ${JSON.stringify(data)}`)
        }),
        awaitReady: vi.fn(async () => {
          order.push('awaitReady')
        }),
        measureFitDimensions: vi.fn(async () => {
          order.push('measure')
          return PHONE
        })
      }
    })
    await measureTerminalViewportOnce(args)
    expect(order).toEqual(['init 80x24 ""', 'awaitReady', 'measure'])
    expect(args.viewportRef.current).toEqual(PHONE)
  })

  it('never re-inits a document that already holds a terminal', async () => {
    const args = onceArgs({ documentHasTerminal: true })
    await measureTerminalViewportOnce(args)
    expect(args.ref?.init).not.toHaveBeenCalled()
    expect(args.viewportRef.current).toEqual(PHONE)
  })
})

function gateArgs(
  overrides: Partial<FirstSubscribeViewportGateArgs> = {}
): FirstSubscribeViewportGateArgs {
  return {
    handle: 'term-1',
    covered: false,
    viewportMeasured: false,
    subscribedDocuments: new Set(),
    subscribingHandles: new Set(),
    subscribeSeq: new Map([['term-1', 1]]),
    measure: vi.fn(async () => {}),
    subscribe: vi.fn(),
    ...overrides
  }
}

describe('deferFirstSubscribeUntilViewportMeasured', () => {
  it('holds the first subscribe of a document until the measure lands, then subscribes once', async () => {
    let finishMeasure = (): void => {}
    const args = gateArgs({
      measure: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishMeasure = resolve
          })
      )
    })
    expect(deferFirstSubscribeUntilViewportMeasured(args)).toBe(true)
    expect(args.measure).toHaveBeenCalledWith('term-1')
    // Other callers see a subscribe in flight and stay out.
    expect(args.subscribingHandles.has('term-1')).toBe(true)
    expect(args.subscribe).not.toHaveBeenCalled()
    finishMeasure()
    await vi.waitFor(() => expect(args.subscribe).toHaveBeenCalledTimes(1))
    expect(args.subscribingHandles.has('term-1')).toBe(false)
    // The resumed subscribe passes straight through.
    expect(deferFirstSubscribeUntilViewportMeasured(args)).toBe(false)
  })

  it('still subscribes, without dims, when the measure fails', async () => {
    const args = gateArgs({ measure: vi.fn(() => Promise.reject(new Error('gone'))) })
    expect(deferFirstSubscribeUntilViewportMeasured(args)).toBe(true)
    await vi.waitFor(() => expect(args.subscribe).toHaveBeenCalledTimes(1))
  })

  function heldSubscribe(subscribeSeq = new Map([['term-1', 1]])) {
    let finishMeasure = (): void => {}
    const args = gateArgs({
      subscribeSeq,
      measure: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishMeasure = resolve
          })
      )
    })
    deferFirstSubscribeUntilViewportMeasured(args)
    return { args, finish: () => finishMeasure() }
  }
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('drops the held subscribe when a newer subscribe generation started during the measure', async () => {
    const subscribeSeq = new Map([['term-1', 1]])
    const { args, finish } = heldSubscribe(subscribeSeq)
    subscribeSeq.set('term-1', 2)
    finish()
    await flush()
    expect(args.subscribe).not.toHaveBeenCalled()
  })

  it('drops the held subscribe when its in-flight mark was cleared during the measure', async () => {
    const { args, finish } = heldSubscribe()
    args.subscribingHandles.delete('term-1')
    finish()
    await flush()
    expect(args.subscribe).not.toHaveBeenCalled()
  })

  it('passes through when the viewport is known, but remembers the document', () => {
    const args = gateArgs({ viewportMeasured: true })
    expect(deferFirstSubscribeUntilViewportMeasured(args)).toBe(false)
    expect(args.subscribedDocuments.has('term-1')).toBe(true)
    // A later refit invalidation must not re-open a live terminal's document.
    expect(deferFirstSubscribeUntilViewportMeasured({ ...args, viewportMeasured: false })).toBe(
      false
    )
    expect(args.measure).not.toHaveBeenCalled()
  })

  it('passes through a native-chat-covered lease, which has no document', () => {
    const args = gateArgs({ covered: true })
    expect(deferFirstSubscribeUntilViewportMeasured(args)).toBe(false)
    expect(args.subscribedDocuments.has('term-1')).toBe(false)
    expect(args.measure).not.toHaveBeenCalled()
  })
})
