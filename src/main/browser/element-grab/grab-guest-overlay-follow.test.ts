import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { BROWSER_GRAB_SELECTED_ATTRIBUTE } from '../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import { buildGuestOverlayScript } from './grab-guest-script'
import { buildGrabLabelAvoidScript } from './grab-guest-overlay-script'
import type { BrowserGrabLabelAvoidArea } from '../../../shared/browser/element-grab/browser-grab-types'

type Rect = { x: number; y: number; width: number; height: number }

const guestAborts: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(guestAborts.splice(0).map((abort) => abort()))
})

async function armGuest(
  previousMarker?: string,
  inShadowRoot = false,
  initialRect: Rect = { x: 40, y: 300, width: 120, height: 30 },
  labelAvoidArea?: BrowserGrabLabelAvoidArea
) {
  const { Window } = await import('happy-dom')
  const window = new Window()
  guestAborts.push(() => window.happyDOM.abort())
  const document = window.document

  // The overlay lives in a closed shadow root; keep a handle so the test can read the outline.
  const shadowRoots: ReturnType<typeof window.HTMLElement.prototype.attachShadow>[] = []
  const attachShadow = window.HTMLElement.prototype.attachShadow
  window.HTMLElement.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init)
    shadowRoots.push(root)
    return root
  }
  // happy-dom has no Popover API; the outline's top-layer placement is checked in Chromium.
  for (const method of ['showPopover', 'hidePopover']) {
    Object.defineProperty(window.HTMLElement.prototype, method, {
      value: () => {},
      configurable: true
    })
  }

  const scroller = document.createElement('div')
  const target = document.createElement('button')
  if (previousMarker !== undefined) {
    target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, previousMarker)
  }
  scroller.appendChild(target)
  const shadowHost = document.createElement('div')
  document.body.appendChild(inShadowRoot ? shadowHost : scroller)
  if (inShadowRoot) {
    const pageRoot = shadowHost.attachShadow({ mode: 'open' })
    pageRoot.appendChild(scroller)
    Object.defineProperty(pageRoot, 'elementFromPoint', { value: () => target })
  }
  let targetRect: Rect = initialRect
  const contentSize = { width: 120, height: 30 }
  const rootSize = { width: 1000, height: 800 }
  const spacing = { padding: 0, border: 0 }
  target.getBoundingClientRect = () =>
    new window.DOMRect(targetRect.x, targetRect.y, targetRect.width, targetRect.height)
  document.elementFromPoint = () => (inShadowRoot ? shadowHost : target)

  const frames: (() => void)[] = []
  const resizeCallbacks: (() => void)[] = []
  const observers: {
    callback: () => void
    boxes: Map<unknown, { box: 'content-box' | 'border-box'; width: number; height: number }>
  }[] = []
  const measure = (element: unknown, box: 'content-box' | 'border-box') => {
    if (element === target) {
      const spacingSize = box === 'border-box' ? 2 * (spacing.padding + spacing.border) : 0
      return { width: contentSize.width + spacingSize, height: contentSize.height + spacingSize }
    }
    return { ...rootSize }
  }
  const context = {
    window,
    document,
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame: () => {},
    ResizeObserver: class {
      private boxes = new Map<
        unknown,
        { box: 'content-box' | 'border-box'; width: number; height: number }
      >()
      constructor(callback: () => void) {
        resizeCallbacks.push(callback)
        observers.push({ callback, boxes: this.boxes })
      }
      observe(element: unknown, options?: { box?: 'content-box' | 'border-box' }): void {
        const box = options?.box ?? 'content-box'
        this.boxes.set(element, { box, ...measure(element, box) })
      }
      disconnect(): void {
        this.boxes.clear()
      }
    }
  }
  expect(runInNewContext(buildGuestOverlayScript('arm'), context)).toBe(true)
  if (labelAvoidArea) {
    expect(runInNewContext(buildGrabLabelAvoidScript(labelAvoidArea), context)).toBe(true)
  }
  const grab: {
    host: { dispatchEvent: (event: unknown) => void }
    freezeHighlight: (selectionId: string) => void
    cleanup: () => void
  } = Object.getOwnPropertyDescriptor(window, '__orcaGrab')?.value
  const flushFrames = (): void => {
    for (const frame of frames.splice(0)) {
      frame()
    }
  }
  const outline = (): Rect => {
    const box = shadowRoots.at(-1)?.firstElementChild?.firstElementChild
    if (!(box instanceof window.HTMLElement)) {
      throw new Error('outline not rendered')
    }
    const style = box.style
    return {
      x: Number.parseFloat(style.left),
      y: Number.parseFloat(style.top),
      width: Number.parseFloat(style.width),
      height: Number.parseFloat(style.height)
    }
  }

  grab.host.dispatchEvent(
    new window.MouseEvent('mousemove', { clientX: initialRect.x + 10, clientY: initialRect.y + 10 })
  )
  flushFrames()
  const hoverLabelStyle =
    shadowRoots.at(-1)?.firstElementChild?.children[1]?.getAttribute('style') ?? ''
  const hoverLabelTop = Number.parseFloat(hoverLabelStyle.match(/top:\s*([\d.-]+)px/)?.[1] ?? 'NaN')
  const hoverLabelLeft = Number.parseFloat(
    hoverLabelStyle.match(/left:\s*([\d.-]+)px/)?.[1] ?? 'NaN'
  )
  grab.freezeHighlight('selection-1')

  return {
    hoverLabelTop,
    hoverLabelLeft,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    window,
    scroller,
    target,
    grab,
    outline,
    flushFrames,
    resizeCallbacks,
    notifyResizes: () => {
      let notifications = 0
      for (const observer of observers) {
        let changed = false
        for (const [element, previous] of observer.boxes) {
          const current = measure(element, previous.box)
          if (current.width !== previous.width || current.height !== previous.height) {
            observer.boxes.set(element, { box: previous.box, ...current })
            changed = true
          }
        }
        if (changed) {
          observer.callback()
          notifications++
        }
      }
      return notifications
    },
    setTargetSpacing: (padding: number, border: number) => {
      spacing.padding = padding
      spacing.border = border
      targetRect = {
        ...targetRect,
        width: contentSize.width + 2 * (padding + border),
        height: contentSize.height + 2 * (padding + border)
      }
    },
    setRootContentSize: (width: number, height: number) => {
      rootSize.width = width
      rootSize.height = height
    },
    moveTarget: (rect: Rect) => {
      targetRect = rect
    }
  }
}

describe('grab overlay after the click', () => {
  it('selects an element inside an open shadow root and follows its scroll', async () => {
    const guest = await armGuest(undefined, true)
    expect(guest.target.getAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)).toBe('selection-1')
    expect(guest.outline()).toEqual({ x: 40, y: 300, width: 120, height: 30 })

    // Scroll events stay inside the shadow root, so window capture never sees them.
    guest.moveTarget({ x: 40, y: 180, width: 120, height: 30 })
    guest.scroller.dispatchEvent(new guest.window.Event('scroll'))
    guest.flushFrames()

    expect(guest.outline()).toEqual({ x: 40, y: 180, width: 120, height: 30 })
  })

  it('does not overwrite a page marker changed after the selection', async () => {
    const guest = await armGuest('page-owned')
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'page-updated')

    guest.grab.cleanup()

    expect(guest.target.getAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)).toBe('page-updated')
  })

  // The label is ~28px tall; the picker assumes 160px wide when the page can't measure it (as here).
  const LABEL = { width: 160, height: 28 }
  const overlaps = (
    label: { left: number; top: number },
    area: { left: number; top: number; right: number; bottom: number }
  ): boolean =>
    label.left < area.right &&
    label.left + LABEL.width > area.left &&
    label.top < area.bottom &&
    label.top + LABEL.height > area.top

  it('puts the hover label below the element when nothing covers that spot', async () => {
    const guest = await armGuest(undefined, false, { x: 40, y: 4, width: 120, height: 30 })

    expect(guest.hoverLabelTop).toBe(40)
    expect(guest.hoverLabelLeft).toBe(40)
  })

  it('keeps the hover label clear of the palette and its hint wherever the palette sits', async () => {
    // The palette dragged right over a top-hugging element, its hint below it: 300–600 × 8–72.
    const { width, height } = await armGuest().then((guest) => guest.viewport)
    const area = { x: 300, y: 8, width: 300, height: 64, frameWidth: width, frameHeight: height }
    const guest = await armGuest(undefined, false, { x: 350, y: 4, width: 120, height: 30 }, area)

    const label = { left: guest.hoverLabelLeft, top: guest.hoverLabelTop }
    expect(overlaps(label, { left: 300, top: 8, right: 600, bottom: 72 })).toBe(false)
    expect(label.top).toBeGreaterThanOrEqual(0)
    expect(label.top + LABEL.height).toBeLessThanOrEqual(height)
  })

  it('converts the palette into a zoomed page’s pixels', async () => {
    // Page zoom 200%: the frame is half the page's CSS width and height in Orca's pixels.
    const { width, height } = await armGuest().then((guest) => guest.viewport)
    const area = {
      x: 150,
      y: 4,
      width: 150,
      height: 32,
      frameWidth: width / 2,
      frameHeight: height / 2
    }
    const guest = await armGuest(undefined, false, { x: 350, y: 4, width: 120, height: 30 }, area)

    const label = { left: guest.hoverLabelLeft, top: guest.hoverLabelTop }
    expect(overlaps(label, { left: 300, top: 8, right: 600, bottom: 72 })).toBe(false)
  })

  it('moves the label under a wrapped palette when there is no room beside it', async () => {
    // A two-row palette spanning the page width at the top: the label goes just under it.
    const { width, height } = await armGuest().then((guest) => guest.viewport)
    const area = {
      x: 8,
      y: 8,
      width: width - 16,
      height: 110,
      frameWidth: width,
      frameHeight: height
    }
    const guest = await armGuest(undefined, false, { x: 40, y: 20, width: 120, height: 30 }, area)

    expect(guest.hoverLabelTop).toBeGreaterThanOrEqual(118)
    expect(
      overlaps(
        { left: guest.hoverLabelLeft, top: guest.hoverLabelTop },
        {
          left: 8,
          top: 8,
          right: width - 8,
          bottom: 118
        }
      )
    ).toBe(false)
  })
})
