// @vitest-environment happy-dom
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useKeyboardAvoidingPadding, useKeyboardOcclusion } from './keyboard-occlusion.web'

/** The browser's own object, as much of it as this file reads: a target that resizes and scrolls. */
class FakeVisualViewport extends EventTarget {
  height: number
  offsetTop = 0
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

  it('answers 0 for a document with no visual viewport at all', async () => {
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
