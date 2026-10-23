import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Window, type HTMLElement, type ShadowRoot } from 'happy-dom'
import { buildGuestOverlayScript } from './grab-guest-script'
import {
  BROWSER_GRAB_SELECTED_ATTRIBUTE,
  buildBrowserAnnotationViewportBridgeScript
} from '../../shared/browser-annotation-viewport-bridge'
import { clampGrabPayload } from './browser-grab-payload'
import { BROWSER_SHADOW_DOM_SCRIPT } from '../../shared/browser-shadow-dom-script'

const windows: Window[] = []
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()))
})

function createGuest(depth: number, mode: 'open' | 'closed' = 'open') {
  const window = new Window({ width: 1000, height: 800 })
  windows.push(window)
  const document = window.document
  const roots: ShadowRoot[] = []
  let container: typeof document.body | ReturnType<typeof document.body.attachShadow> =
    document.body
  let outer: HTMLElement = document.body
  for (let index = 0; index < depth; index++) {
    const host = document.createElement('section')
    host.id = `host-${index}`
    container.appendChild(host)
    if (index === 0) {
      outer = host
    }
    const root = host.attachShadow({ mode })
    roots.push(root)
    container = root
  }
  const scroller = document.createElement('div')
  const target = document.createElement('button')
  target.id = 'control'
  target.textContent = 'Choose item'
  scroller.appendChild(target)
  container.appendChild(scroller)
  let y = 300
  target.getBoundingClientRect = () => new window.DOMRect(40, y, 120, 30)
  document.elementFromPoint = () => (depth ? outer : target)
  roots.forEach((root, index) => {
    Object.defineProperty(root, 'elementFromPoint', {
      value: () => roots[index + 1]?.host ?? target
    })
  })
  const frames = new Map<number, () => void>()
  let frameId = 0
  const reports: { target: unknown }[] = []
  const context = {
    window,
    document,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    URL,
    requestAnimationFrame: (callback: () => void) => {
      frames.set(++frameId, callback)
      return frameId
    },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    console: {
      debug: (message: string) => reports.push(JSON.parse(message.slice(message.indexOf(':{') + 1)))
    }
  }
  let overlayRoot: ReturnType<typeof document.body.attachShadow> | undefined
  const attachShadow = window.HTMLElement.prototype.attachShadow
  window.HTMLElement.prototype.attachShadow = function (init) {
    const root = attachShadow.call(this, init)
    overlayRoot = root
    return root
  }
  runInNewContext(buildGuestOverlayScript('arm'), context)
  const grab: {
    host: typeof target
    getCurrentElement: () => typeof target
    extractPayload: (element: typeof target) => unknown
    freezeHighlight: (id: string) => void
    cleanup: () => void
  } = Object.getOwnPropertyDescriptor(window, '__orcaGrab')?.value
  const flush = () => {
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach((callback) => callback())
  }
  const hover = () => {
    grab.host.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 50, clientY: 310 }))
    flush()
  }
  const installBridge = (enabled = true) => {
    runInNewContext(
      buildBrowserAnnotationViewportBridgeScript({
        enabled,
        emitViewport: true,
        markers: [],
        selectionId: 'selection-1',
        token: 'shadow-test-token'
      }),
      context
    )
    flush()
  }
  return {
    window,
    document,
    roots,
    outer,
    scroller,
    target,
    grab,
    context,
    reports,
    flush,
    hover,
    installBridge,
    outlineTop: () => overlayRoot?.firstElementChild?.firstElementChild?.getAttribute('style'),
    move: (next: number) => {
      y = next
    },
    payload: () => clampGrabPayload(grab.extractPayload(target))
  }
}

describe('guest selection across shadow roots', () => {
  it.each([0, 1, 2])('picks the internal control through %i open roots', (depth) => {
    const guest = createGuest(depth)
    guest.hover()
    expect(guest.grab.getCurrentElement()).toBe(guest.target)
    expect(guest.payload()?.target.tagName).toBe('button')
  })

  it('stops hit-testing at a bounded shadow depth', () => {
    const guest = createGuest(40)
    guest.hover()
    expect(guest.grab.getCurrentElement().id).toBe('host-32')
    expect(guest.grab.getCurrentElement()).not.toBe(guest.target)
    expect(guest.payload()?.target.selector.length).toBeLessThanOrEqual(714)
  })

  it('disambiguates hosts with the same ID in the outer root', () => {
    const guest = createGuest(1)
    const host = guest.document.createElement('section')
    host.id = 'host-0'
    host.attachShadow({ mode: 'open' }).innerHTML = '<button id="control">Decoy</button>'
    guest.document.body.appendChild(host)
    expect(guest.payload()?.target.selector).toBe(
      'section#host-0:nth-of-type(1) >>> button#control'
    )
  })

  it('keeps a closed root opaque', () => {
    const guest = createGuest(1, 'closed')
    guest.hover()
    expect(guest.grab.getCurrentElement()).toBe(guest.outer)
  })

  it('qualifies duplicate IDs by their root boundaries', () => {
    const guest = createGuest(2)
    const decoy = guest.document.createElement('button')
    decoy.id = 'control'
    guest.document.body.appendChild(decoy)
    const payload = guest.payload()
    expect(payload?.target.selector).toBe('section#host-0 >>> section#host-1 >>> button#control')
    expect(payload?.target.elementPath).toContain('#host-0 >>> #host-1 >>>')
    expect(payload?.target.fullPath).toContain('section#host-0 >>> section#host-1 >>>')
    expect(payload?.ancestorPath).toContain('#shadow-root (open)')
  })

  it('keeps sibling context and accessible labels scoped to the selected root', () => {
    const guest = createGuest(1)
    const label = guest.document.createElement('span')
    label.id = 'label'
    label.textContent = 'Internal label'
    label.getBoundingClientRect = () => new guest.window.DOMRect(10, 10, 100, 20)
    guest.roots[0].appendChild(label)
    guest.roots[0].appendChild(guest.target)
    guest.target.setAttribute('aria-labelledby', 'label')
    const decoy = guest.document.createElement('span')
    decoy.id = 'label'
    decoy.textContent = 'Unrelated label'
    guest.document.body.appendChild(decoy)
    const payload = guest.payload()
    expect(payload?.target.accessibility.accessibleName).toBe('Internal label')
    expect(payload?.nearbyText).toContain('Internal label')
    expect(payload?.target.nearbyElements).toContain('span "Internal label"')
  })

  it('disambiguates duplicate siblings inside the same root', () => {
    const guest = createGuest(1)
    const decoy = guest.target.cloneNode(true)
    guest.scroller.appendChild(decoy)
    expect(guest.payload()?.target.selector).toBe(
      'section#host-0 >>> button#control:nth-of-type(1)'
    )
  })

  it('recognizes fixed and slotted sticky ancestors', () => {
    const guest = createGuest(1)
    guest.outer.style.position = 'fixed'
    expect(guest.payload()?.target.isFixed).toBe(true)
    guest.outer.style.position = ''
    const slot = guest.document.createElement('slot')
    const sticky = guest.document.createElement('div')
    sticky.style.position = 'sticky'
    sticky.appendChild(slot)
    guest.roots[0].appendChild(sticky)
    guest.outer.appendChild(guest.target)
    // happy-dom does not distribute slots; Chromium coverage uses the real assignedSlot.
    Object.defineProperty(guest.target, 'assignedSlot', { value: slot })
    expect(guest.payload()?.target.isFixed).toBe(true)
  })

  it.each(['fixed', 'sticky'])('recognizes a %s ancestor beyond 120 normal levels', (position) => {
    const guest = createGuest(0)
    const ancestor = guest.document.createElement('section')
    ancestor.style.position = position
    guest.document.body.appendChild(ancestor)
    let container = ancestor
    for (let index = 0; index < 120; index++) {
      const child = guest.document.createElement('div')
      container.appendChild(child)
      container = child
    }
    container.appendChild(guest.scroller)
    expect(guest.payload()?.target.isFixed).toBe(true)
  })

  it('tracks scroll in an outer root beyond 120 composed ancestors', () => {
    const guest = createGuest(2)
    const scroller = guest.document.createElement('div')
    guest.roots[0].appendChild(scroller)
    const innerHost = guest.roots[1].host
    if (!innerHost) {
      throw new Error('Expected an inner shadow host')
    }
    scroller.appendChild(innerHost)
    let container = guest.document.createElement('div')
    guest.roots[1].appendChild(container)
    for (let index = 0; index < 120; index++) {
      const child = guest.document.createElement('div')
      container.appendChild(child)
      container = child
    }
    container.appendChild(guest.scroller)
    const roots = runInNewContext(`${BROWSER_SHADOW_DOM_SCRIPT}\nshadowSelectionRoots(element)`, {
      ...guest.context,
      element: guest.target
    })
    expect(roots).toHaveLength(2)
    expect(roots[1]).toBe(guest.roots[0])
    guest.hover()
    guest.grab.freezeHighlight('selection-1')
    guest.installBridge()
    guest.move(120)
    scroller.dispatchEvent(new guest.window.Event('scroll', { composed: false }))
    guest.flush()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 120, width: 120, height: 30 })
    expect(guest.outlineTop()).toContain('top: 120px')
  })

  it.each([1, 2])('terminates a composed parent cycle of %i elements', (length) => {
    const guest = createGuest(1)
    const slot = guest.document.createElement('slot')
    guest.roots[0].appendChild(slot)
    Object.defineProperty(guest.target, 'assignedSlot', {
      value: length === 1 ? guest.target : slot
    })
    Object.defineProperty(slot, 'assignedSlot', { value: guest.target })
    expect(guest.payload()?.target.isFixed).toBe(false)
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.installBridge()
    guest.move(120)
    guest.scroller.dispatchEvent(new guest.window.Event('scroll', { composed: false }))
    guest.flush()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 120, width: 120, height: 30 })
  })

  it('selects without activating the application button', async () => {
    const guest = createGuest(2)
    let actions = 0
    guest.target.addEventListener('click', () => actions++)
    guest.hover()
    const pending = runInNewContext(buildGuestOverlayScript('awaitClick'), guest.context)
    const click = new guest.window.MouseEvent('click', { bubbles: true, cancelable: true })
    guest.grab.host.dispatchEvent(click)
    const payload = clampGrabPayload(await pending)
    expect(payload?.target.tagName).toBe('button')
    expect(actions).toBe(0)
    expect(click.defaultPrevented).toBe(true)
    guest.grab.cleanup()
  })

  it('sanitizes secret IDs and preserves payload budgets inside roots', () => {
    const guest = createGuest(2)
    guest.outer.id = 'access_token=private-value'
    guest.target.textContent = 'x'.repeat(10000)
    const payload = guest.payload()
    expect(JSON.stringify(payload)).not.toContain('private-value')
    expect(payload?.target.textSnippet.length).toBeLessThanOrEqual(214)
    expect(payload?.target.selector.length).toBeLessThanOrEqual(714)
  })

  it('follows non-composed inner scroll and cleans up tracking', () => {
    const guest = createGuest(2)
    guest.hover()
    guest.grab.freezeHighlight('selection-1')
    guest.installBridge()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 300, width: 120, height: 30 })
    guest.move(120)
    guest.scroller.dispatchEvent(new guest.window.Event('scroll', { composed: false }))
    guest.flush()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 120, width: 120, height: 30 })
    expect(guest.outlineTop()).toContain('top: 120px')
    guest.grab.cleanup()
    expect(guest.target.hasAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)).toBe(false)
    guest.installBridge(false)
    const count = guest.reports.length
    guest.scroller.dispatchEvent(new guest.window.Event('scroll'))
    guest.flush()
    expect(guest.reports).toHaveLength(count)
  })

  it('restores shadow markers and cancels queued updates during teardown', () => {
    const guest = createGuest(1)
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'page-owned')
    guest.hover()
    guest.grab.freezeHighlight('selection-1')
    guest.installBridge()
    guest.scroller.dispatchEvent(new guest.window.Event('scroll'))
    guest.installBridge(false)
    guest.grab.cleanup()
    expect(guest.target.getAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE)).toBe('page-owned')
    const count = guest.reports.length
    guest.scroller.dispatchEvent(new guest.window.Event('scroll'))
    guest.flush()
    expect(guest.reports).toHaveLength(count)
  })

  it.each([0, 1])('follows inner scroll with 12000 normal nodes and %i shadow roots', (depth) => {
    const guest = createGuest(depth)
    const fragment = guest.document.createDocumentFragment()
    for (let index = 0; index < 12000; index++) {
      fragment.appendChild(guest.document.createElement('i'))
    }
    guest.document.body.insertBefore(
      fragment,
      guest.outer === guest.document.body ? guest.scroller : guest.outer
    )
    guest.hover()
    guest.grab.freezeHighlight('selection-1')
    guest.installBridge()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 300, width: 120, height: 30 })
    guest.move(120)
    guest.scroller.dispatchEvent(new guest.window.Event('scroll', { composed: false }))
    guest.flush()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 120, width: 120, height: 30 })
    expect(guest.outlineTop()).toContain('top: 120px')
  })

  it.each(['normal', 'same-root', 'cross-root', 'mixed', 'mixed-normal-target'])(
    'rejects %s duplicate markers',
    (scope) => {
      const guest = createGuest(scope === 'normal' ? 0 : 2)
      if (scope === 'mixed-normal-target') {
        guest.document.body.appendChild(guest.target)
      }
      guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
      const decoy = guest.document.createElement('button')
      decoy.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
      const container =
        scope === 'same-root'
          ? guest.scroller
          : scope === 'cross-root' || scope === 'mixed-normal-target'
            ? guest.roots[0]
            : guest.document.body
      container.appendChild(decoy)
      guest.installBridge()
      expect(guest.reports.at(-1)?.target).toBeNull()
      decoy.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'another-selection')
      guest.window.dispatchEvent(new guest.window.Event('resize'))
      guest.flush()
      expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 300, width: 120, height: 30 })
    }
  )

  it.each([0, 1])(
    'returns no marker when a shadow scan is incomplete with a target at depth %i',
    (depth) => {
      const guest = createGuest(depth)
      guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
      const host = guest.document.createElement('section')
      guest.document.body.appendChild(host)
      const root = host.attachShadow({ mode: 'open' })
      const fragment = guest.document.createDocumentFragment()
      for (let index = 0; index < 10020; index++) {
        fragment.appendChild(guest.document.createElement('i'))
      }
      root.appendChild(fragment)
      guest.installBridge()
      expect(guest.reports.at(-1)?.target).toBeNull()
    }
  )

  it('rejects markers duplicated across roots and disconnected targets', () => {
    const guest = createGuest(2)
    guest.target.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    const decoy = guest.document.createElement('button')
    decoy.setAttribute(BROWSER_GRAB_SELECTED_ATTRIBUTE, 'selection-1')
    guest.roots[0].appendChild(decoy)
    guest.installBridge()
    expect(guest.reports.at(-1)?.target).toBeNull()
    decoy.remove()
    guest.installBridge()
    expect(guest.reports.at(-1)?.target).toEqual({ x: 40, y: 300, width: 120, height: 30 })
    guest.target.remove()
    guest.window.dispatchEvent(new guest.window.Event('resize'))
    guest.flush()
    expect(guest.reports.at(-1)?.target).toBeNull()
  })
})
