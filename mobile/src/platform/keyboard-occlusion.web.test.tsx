// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  currentSoftKeyboardHeight,
  subscribeSoftKeyboard,
  useKeyboardOcclusion,
  useSoftKeyboard,
  publishShellKeyboardSource,
  type SoftKeyboardState
} from './keyboard-occlusion.web'

/** The browser's own object, as much of it as this file reads: a target that resizes and scrolls. */
class FakeVisualViewport extends EventTarget {
  height: number
  offsetTop = 0
  /** Optional as the browser's is: older WebViews do not implement it. */
  scale: number | undefined = 1
  readonly counts = { resize: 0, scroll: 0 }

  constructor(height: number) {
    super()
    this.height = height
  }

  override addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'resize' || type === 'scroll') {
      this.counts[type] += 1
    }
    super.addEventListener(type, listener)
  }

  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'resize' || type === 'scroll') {
      this.counts[type] -= 1
    }
    super.removeEventListener(type, listener)
  }

  /** The keyboard opening: the layout viewport keeps its size and this one shrinks. */
  resizeTo(height: number, offsetTop = 0): void {
    this.height = height
    this.offsetTop = offsetTop
    this.dispatchEvent(new Event('resize'))
  }

  /** Pinch zoom: the visual viewport shrinks by the scale factor with no keyboard anywhere. */
  zoomTo(scale: number): void {
    this.scale = scale
    this.height = LAYOUT_HEIGHT / scale
    this.offsetTop = 0
    this.dispatchEvent(new Event('resize'))
  }

  scrollTo(offsetTop: number): void {
    this.offsetTop = offsetTop
    this.dispatchEvent(new Event('scroll'))
  }
}

const LAYOUT_HEIGHT = 800
let viewport: FakeVisualViewport | null = null
let lift = 0

function Harness(): null {
  lift = useKeyboardOcclusion()
  return null
}

async function mount(): Promise<ReturnType<typeof create>> {
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(createElement(Harness))
  })
  if (tree === null) {
    throw new Error('the harness did not mount')
  }
  return tree
}

beforeEach(() => {
  lift = 0
  viewport = new FakeVisualViewport(LAYOUT_HEIGHT)
  Object.defineProperty(window, 'innerHeight', { value: LAYOUT_HEIGHT, configurable: true })
  Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
})

afterEach(() => {
  Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
})

describe('the keyboard the browser reports', () => {
  it('reads nothing covered while the visual viewport fills the layout one', async () => {
    await mount()
    expect(lift).toBe(0)
  })

  it('lifts by the strip the visual viewport stops covering', async () => {
    await mount()
    await act(async () => viewport?.resizeTo(464))
    expect(lift).toBe(336)
  })

  it('counts an offset visual viewport, which a height alone would read as keyboard', async () => {
    // A scrolled or pinched visual viewport sits partway down the layout viewport; the strip below
    // it is not the keyboard, and subtracting only the height would call it one.
    await mount()
    await act(async () => viewport?.resizeTo(464, 100))
    expect(lift).toBe(236)
  })

  it('follows a scroll that moves the offset without resizing anything', async () => {
    await mount()
    await act(async () => viewport?.resizeTo(464))
    await act(async () => viewport?.scrollTo(50))
    expect(lift).toBe(286)
  })

  it('drops back to nothing when the keyboard closes', async () => {
    await mount()
    await act(async () => viewport?.resizeTo(464))
    await act(async () => viewport?.resizeTo(LAYOUT_HEIGHT))
    expect(lift).toBe(0)
  })

  it('reads the keyboard already up at mount, which sends no event', async () => {
    viewport?.resizeTo(464)
    await mount()
    expect(lift).toBe(336)
  })

  it('never reports a negative strip, whatever the two viewports disagree about', async () => {
    // Mobile Safari reports a visual viewport taller than the layout one mid-scroll, and a bare
    // subtraction would push the commit bar down the screen instead of up.
    await mount()
    await act(async () => viewport?.resizeTo(LAYOUT_HEIGHT + 120))
    expect(lift).toBe(0)
  })

  it('reads a pinch zoom as no keyboard, because geometry alone cannot tell them apart', async () => {
    // A 2x zoom halves the visual viewport exactly as a 400px keyboard would, and answering 400
    // here moves the commit bar and the composer on a page nobody is typing into.
    await mount()
    await act(async () => viewport?.zoomTo(2))
    expect(lift).toBe(0)
  })

  it('goes back to measuring once the zoom is released', async () => {
    await mount()
    await act(async () => viewport?.zoomTo(2))
    await act(async () => viewport?.zoomTo(1))
    await act(async () => viewport?.resizeTo(464))
    expect(lift).toBe(336)
  })

  it('answers 0 for a keyboard raised while the page is zoomed, which is the accepted loss', async () => {
    // The ruling's own case: scale 2 *and* a viewport shrunk well past what the zoom alone
    // explains. Nothing in the geometry separates the keyboard's share from the zoom's, so the
    // seam declines rather than guessing. What keeps this off the ordinary focus path is the
    // input floor — every text input in the two page closures clears 16px on the web, so a focus
    // does not zoom and a scale other than 1 means a user pinched.
    await mount()
    await act(async () => viewport?.zoomTo(2))
    await act(async () => viewport?.resizeTo(232))
    expect(viewport?.scale).toBe(2)
    expect(lift).toBe(0)
  })

  it('takes a viewport that reports no scale as unzoomed', async () => {
    // `scale` is absent on older WebViews; treating that as zoomed would answer 0 for every
    // keyboard on them.
    await mount()
    await act(async () => {
      if (viewport !== null) {
        viewport.scale = undefined
        viewport.resizeTo(464)
      }
    })
    expect(lift).toBe(336)
  })

  it('answers 0 when the effect finds no visual viewport to subscribe to', async () => {
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    await mount()
    expect(lift).toBe(0)
  })

  it('removes both listeners on unmount', async () => {
    const tree = await mount()
    expect(viewport?.counts).toEqual({ resize: 1, scroll: 1 })
    await act(async () => tree.unmount())
    expect(viewport?.counts).toEqual({ resize: 0, scroll: 0 })
  })
})

/** The pair a sheet animates with: events rather than state, each with duration 0. */
describe('the keyboard as events, for a sheet', () => {
  it('shows by the uncovered strip and hides once when it closes', () => {
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      (height, duration) => calls.push(`show ${height} ${duration}`),
      (duration) => calls.push(`hide ${duration}`)
    )
    viewport?.resizeTo(464)
    viewport?.resizeTo(LAYOUT_HEIGHT)
    viewport?.resizeTo(LAYOUT_HEIGHT)
    expect(calls).toEqual(['show 336 0', 'hide 0'])
    unsubscribe()
    expect(viewport?.counts).toEqual({ resize: 0, scroll: 0 })
  })

  it('hides a keyboard that was already up when it subscribed', async () => {
    viewport?.resizeTo(464)
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      (height) => calls.push(`show ${height}`),
      (duration) => calls.push(`hide ${duration}`)
    )
    viewport?.resizeTo(LAYOUT_HEIGHT)
    expect(calls).toEqual(['hide 0'])
    unsubscribe()
    // The hook seeds from the same strip, so it must come back down too.
    viewport?.resizeTo(464)
    await mount()
    expect(lift).toBe(336)
    await act(async () => viewport?.resizeTo(LAYOUT_HEIGHT))
    expect(lift).toBe(0)
  })

  it('stays silent while the visual viewport covers nothing', () => {
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      () => calls.push('show'),
      () => calls.push('hide')
    )
    viewport?.resizeTo(LAYOUT_HEIGHT)
    expect(calls).toEqual([])
    unsubscribe()
  })

  it('reads a keyboard already up, and 0 without a visual viewport', () => {
    viewport?.resizeTo(464)
    expect(currentSoftKeyboardHeight()).toBe(336)
    Object.defineProperty(window, 'visualViewport', { value: undefined, configurable: true })
    expect(currentSoftKeyboardHeight()).toBe(0)
    expect(() =>
      subscribeSoftKeyboard(
        () => {},
        () => {}
      )()
    ).not.toThrow()
  })
})

let keyboardState: SoftKeyboardState = { height: 0, visible: false }

function StateHarness(): null {
  keyboardState = useSoftKeyboard()
  return null
}

async function mountState(): Promise<ReturnType<typeof create>> {
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(createElement(StateHarness))
  })
  if (tree === null) {
    throw new Error('the harness did not mount')
  }
  return tree
}

/** The shell's side of the bridge, as the entry publishes it: the height `init` last carried. */
function createShellKeyboard(initial = 0) {
  let height = initial
  const listeners = new Set<(height: number) => void>()
  return {
    source: {
      read: () => height,
      subscribe: (listener: (height: number) => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      }
    },
    move: (next: number) => {
      height = next
      for (const listener of listeners) {
        listener(next)
      }
    },
    listenerCount: () => listeners.size
  }
}

describe('the state a native screen reads, from the browser outside the shell', () => {
  it('is open exactly while something is covered', async () => {
    const tree = await mountState()
    expect(keyboardState).toEqual({ height: 0, visible: false })
    await act(async () => viewport?.resizeTo(464))
    expect(keyboardState).toEqual({ height: 336, visible: true })
    await act(async () => viewport?.resizeTo(LAYOUT_HEIGHT))
    expect(keyboardState).toEqual({ height: 0, visible: false })
    await act(async () => tree.unmount())
  })
})

/**
 * Inside the shell the keyboard covers the page as it covers a native screen, but the page cannot
 * measure it: the WebView's IME insets are zeroed, so `visualViewport` never moves. The shell says
 * the height over the bridge, and every reader here answers from that.
 */
describe('the keyboard the shell says covers the page', () => {
  afterEach(() => {
    publishShellKeyboardSource(null)
  })

  it('answers the height the shell sent, and ignores the visual viewport', async () => {
    const shell = createShellKeyboard()
    publishShellKeyboardSource(shell.source)
    const tree = await mountState()
    const lifted = await mount()
    // Pixel_API_37: the IME opens at 312 and the suggestion strip grows it to 346.
    for (const height of [312, 346]) {
      await act(async () => shell.move(height))
      expect(keyboardState).toEqual({ height, visible: true })
      expect(lift).toBe(height)
    }
    await act(async () => viewport?.resizeTo(464))
    expect(keyboardState.height).toBe(346)
    await act(async () => shell.move(0))
    expect(keyboardState).toEqual({ height: 0, visible: false })
    expect(lift).toBe(0)
    await act(async () => {
      tree.unmount()
      lifted.unmount()
    })
    expect(shell.listenerCount()).toBe(0)
  })

  it('reads a keyboard already up at mount, which the shell sent in the first init', async () => {
    publishShellKeyboardSource(createShellKeyboard(312).source)
    expect(currentSoftKeyboardHeight()).toBe(312)
    const tree = await mountState()
    expect(keyboardState).toEqual({ height: 312, visible: true })
    await act(async () => tree.unmount())
  })

  it('hands a sheet each height as a show and the close as one hide', () => {
    const shell = createShellKeyboard()
    publishShellKeyboardSource(shell.source)
    const calls: string[] = []
    const unsubscribe = subscribeSoftKeyboard(
      (height, duration) => calls.push(`show ${height} ${duration}`),
      (duration) => calls.push(`hide ${duration}`)
    )
    viewport?.resizeTo(464)
    shell.move(312)
    shell.move(346)
    shell.move(0)
    shell.move(0)
    expect(calls).toEqual(['show 312 0', 'show 346 0', 'hide 0'])
    unsubscribe()
    expect(shell.listenerCount()).toBe(0)
    expect(viewport?.counts).toEqual({ resize: 0, scroll: 0 })
  })
})
