// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  useKeyboardAvoidingPadding,
  useKeyboardOcclusion,
  useSoftKeyboard,
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
let padding = 0

function Harness(): null {
  lift = useKeyboardOcclusion()
  padding = useKeyboardAvoidingPadding()
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
  padding = 0
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

  it('is the whole of the avoidance here, where KeyboardAvoidingView is inert', async () => {
    await mount()
    await act(async () => viewport?.resizeTo(464))
    expect(padding).toBe(336)
  })

  it('removes both listeners on unmount', async () => {
    const tree = await mount()
    expect(viewport?.counts).toEqual({ resize: 2, scroll: 2 })
    await act(async () => tree.unmount())
    expect(viewport?.counts).toEqual({ resize: 0, scroll: 0 })
  })
})

const LAYOUT_WIDTH = 400
let keyboardState: SoftKeyboardState = { height: 0, visible: false }

function StateHarness(): null {
  keyboardState = useSoftKeyboard()
  return null
}

function resizeWindow(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  window.dispatchEvent(new Event('resize'))
}

/** Tracked so a case that resizes the window is not also re-rendering an earlier case's harness,
 *  which shares this file's one `keyboardState`. */
const mountedStateHarnesses: ReturnType<typeof create>[] = []

async function mountState(): Promise<ReturnType<typeof create>> {
  let tree: ReturnType<typeof create> | null = null
  await act(async () => {
    tree = create(createElement(StateHarness))
  })
  if (tree === null) {
    throw new Error('the harness did not mount')
  }
  mountedStateHarnesses.push(tree)
  return tree
}

/**
 * The shell shortens the WebView to sit above the IME, so by the time the page measures itself
 * nothing is covered and `visualViewport` reads full height. The resize is what is left.
 */
describe('the keyboard the page cannot see, because the shell already moved it', () => {
  beforeEach(() => {
    act(() => {
      for (const tree of mountedStateHarnesses.splice(0)) {
        tree.unmount()
      }
    })
    keyboardState = { height: 0, visible: false }
    Object.defineProperty(window, 'innerWidth', { value: LAYOUT_WIDTH, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: LAYOUT_HEIGHT, configurable: true })
  })

  it('reads no keyboard while the window keeps the height it mounted at', async () => {
    await mountState()
    expect(keyboardState).toEqual({ height: 0, visible: false })
  })

  it('calls the window shortened at an unchanged width the keyboard, and covers nothing by it', async () => {
    await mountState()
    await act(async () => resizeWindow(LAYOUT_WIDTH, LAYOUT_HEIGHT - 336))
    expect(keyboardState).toEqual({ height: 0, visible: true })
  })

  it('drops the flag when the window gets its height back', async () => {
    await mountState()
    await act(async () => resizeWindow(LAYOUT_WIDTH, LAYOUT_HEIGHT - 336))
    await act(async () => resizeWindow(LAYOUT_WIDTH, LAYOUT_HEIGHT))
    expect(keyboardState.visible).toBe(false)
  })

  it('reads a rotation as a new window rather than a keyboard, because the width moved too', async () => {
    await mountState()
    await act(async () => resizeWindow(LAYOUT_HEIGHT, LAYOUT_WIDTH))
    expect(keyboardState.visible).toBe(false)
    // And the shorter window is now the one the next keyboard is measured against.
    await act(async () => resizeWindow(LAYOUT_HEIGHT, LAYOUT_WIDTH - 200))
    expect(keyboardState.visible).toBe(true)
  })

  it('takes a window that grew as the new resting height, not as a keyboard closing twice', async () => {
    await mountState()
    await act(async () => resizeWindow(LAYOUT_WIDTH, LAYOUT_HEIGHT + 60))
    expect(keyboardState.visible).toBe(false)
    await act(async () => resizeWindow(LAYOUT_WIDTH, LAYOUT_HEIGHT))
    expect(keyboardState.visible).toBe(true)
  })

  it('stops listening on unmount', async () => {
    const tree = await mountState()
    await act(async () => tree.unmount())
    await act(async () => resizeWindow(LAYOUT_WIDTH, LAYOUT_HEIGHT - 336))
    expect(keyboardState.visible).toBe(false)
  })
})
