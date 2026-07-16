// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildBrowserClickedLinkRoutingScript,
  buildBrowserIframeClickedLinkRoutingScript,
  installBrowserIframeClickedLinkRouting,
  installBrowserClickedLinkRouting
} from './browser-clicked-link-routing'

const FOREGROUND_FRAME_NAME = '__orca_clicked_link_foreground_test'

type RoutingGlobal = typeof globalThis & {
  __orcaBrowserClickedLinkRouting?: {
    listener: (event: MouseEvent) => void
  }
}

let cleanupIframeRouting: (() => void) | null = null

function resetRouting(): void {
  const routingGlobal = globalThis as RoutingGlobal
  const state = routingGlobal.__orcaBrowserClickedLinkRouting
  if (state) {
    window.removeEventListener('click', state.listener)
    window.removeEventListener('auxclick', state.listener)
  }
  delete routingGlobal.__orcaBrowserClickedLinkRouting
  cleanupIframeRouting?.()
  cleanupIframeRouting = null
}

function installRouting(isMac = true): void {
  installBrowserClickedLinkRouting(FOREGROUND_FRAME_NAME, isMac, true)
}

function clickLink(
  link: Element,
  init: MouseEventInit & { type?: 'click' | 'auxclick' } = {}
): { event: MouseEvent; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  vi.spyOn(window, 'open').mockImplementation(open)
  const { type = 'click', ...eventInit } = init
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: type === 'auxclick' ? 1 : 0,
    ...eventInit
  })
  link.dispatchEvent(event)
  return { event, open }
}

describe('browser clicked-link routing', () => {
  beforeEach(() => {
    resetRouting()
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  afterEach(() => {
    resetRouting()
    vi.restoreAllMocks()
  })

  it('routes plain target=_blank links back into the current Orca tab', () => {
    const link = document.createElement('a')
    link.href = 'https://docs.example.com/guide'
    link.target = '_blank'
    document.body.append(link)
    installRouting()

    const { event, open } = clickLink(link)

    expect(event.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(link.getAttribute('target')).toBe('_self')
  })

  it('routes the host-platform modifier without trusting an emulated guest user agent', () => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'
    })
    const link = document.createElement('a')
    link.href = 'https://example.com/reference'
    document.body.append(link)
    installRouting(false)

    expect(clickLink(link, { metaKey: true }).open).not.toHaveBeenCalled()
    expect(clickLink(link, { ctrlKey: true }).open).toHaveBeenCalledWith(
      'https://example.com/reference',
      FOREGROUND_FRAME_NAME
    )
  })

  it('routes middle clicks and primary-modifier plus Shift clicks as new-tab intents', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com/reference'
    document.body.append(link)
    installRouting()

    expect(clickLink(link, { type: 'auxclick' }).open).toHaveBeenCalledWith(
      'https://example.com/reference',
      FOREGROUND_FRAME_NAME
    )
    expect(clickLink(link, { metaKey: true, shiftKey: true }).open).toHaveBeenCalledWith(
      'https://example.com/reference',
      FOREGROUND_FRAME_NAME
    )
  })

  it('honors page cancellation and observes link rewrites before routing', () => {
    const cancelled = document.createElement('a')
    cancelled.href = 'https://example.com/original'
    cancelled.target = '_blank'
    cancelled.addEventListener('click', (event) => event.preventDefault())
    const rewritten = document.createElement('a')
    rewritten.href = 'https://example.com/original'
    rewritten.target = '_blank'
    rewritten.addEventListener('click', () => {
      rewritten.href = 'https://example.com/rewritten'
    })
    document.body.append(cancelled, rewritten)
    installRouting()

    expect(clickLink(cancelled).open).not.toHaveBeenCalled()
    expect(cancelled.getAttribute('target')).toBe('_blank')
    expect(clickLink(rewritten).open).not.toHaveBeenCalled()
    expect(rewritten.href).toBe('https://example.com/rewritten')
    expect(rewritten.getAttribute('target')).toBe('_self')
  })

  it('routes SVG links but leaves download links and links without href alone', () => {
    const svgLink = document.createElementNS('http://www.w3.org/2000/svg', 'a')
    svgLink.setAttribute('href', 'https://example.com/svg')
    svgLink.setAttribute('target', '_blank')
    const areaDownload = document.createElement('area')
    areaDownload.href = 'https://example.com/archive.zip'
    areaDownload.target = '_blank'
    areaDownload.download = 'archive.zip'
    const noHref = document.createElement('a')
    noHref.target = '_blank'
    document.body.append(svgLink, areaDownload, noHref)
    installRouting()

    expect(clickLink(svgLink).open).not.toHaveBeenCalled()
    expect(svgLink.getAttribute('target')).toBe('_self')
    expect(clickLink(areaDownload).open).not.toHaveBeenCalled()
    expect(clickLink(noHref).open).not.toHaveBeenCalled()
  })

  it('leaves ordinary same-tab, Shift-window, Alt, and unsafe links to Chromium', () => {
    const sameTab = document.createElement('a')
    sameTab.href = 'https://example.com/current'
    const shifted = document.createElement('a')
    shifted.href = 'https://example.com/window'
    shifted.target = '_blank'
    const altClicked = document.createElement('a')
    altClicked.href = 'https://example.com/download'
    altClicked.target = '_blank'
    const unsafe = document.createElement('a')
    unsafe.href = 'javascript:void(0)'
    unsafe.target = '_blank'
    document.body.append(sameTab, shifted, altClicked, unsafe)
    installRouting()

    expect(clickLink(sameTab).open).not.toHaveBeenCalled()
    expect(clickLink(shifted, { shiftKey: true }).open).not.toHaveBeenCalled()
    expect(clickLink(altClicked, { altKey: true }).open).not.toHaveBeenCalled()
    expect(clickLink(unsafe).open).not.toHaveBeenCalled()
  })

  it('updates an existing isolated-world installation without adding another listener', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const link = document.createElement('a')
    link.href = 'https://example.com/reference'
    document.body.append(link)
    installBrowserClickedLinkRouting('__orca_clicked_link_old_fg', true, true)
    installBrowserClickedLinkRouting('__orca_clicked_link_new_fg', false, true)

    expect(addEventListener.mock.calls.filter(([event]) => event === 'click')).toHaveLength(1)
    expect(clickLink(link, { ctrlKey: true }).open).toHaveBeenCalledWith(
      'https://example.com/reference',
      '__orca_clicked_link_new_fg'
    )
  })

  it('builds a self-contained isolated-world script', () => {
    const script = buildBrowserClickedLinkRoutingScript(FOREGROUND_FRAME_NAME, false)

    expect(script).toContain('installBrowserClickedLinkRouting')
    expect(script).toContain(`"${FOREGROUND_FRAME_NAME}",false`)
    expect(script).not.toContain('BrowserClickedLinkRoutingState')
  })

  it('routes plain iframe target=_blank links into the top-level guest', () => {
    const link = document.createElement('a')
    link.href = 'https://example.com/from-frame'
    link.target = '_blank'
    document.body.append(link)
    cleanupIframeRouting = installBrowserIframeClickedLinkRouting(FOREGROUND_FRAME_NAME, true, true)

    const { event, open } = clickLink(link)

    expect(event.defaultPrevented).toBe(false)
    expect(open).not.toHaveBeenCalled()
    expect(link.getAttribute('target')).toBe('_top')
  })

  it('routes explicit iframe new-tab gestures through one-use frame names', () => {
    const blank = document.createElement('a')
    blank.href = 'https://example.com/new-context'
    blank.target = '_blank'
    document.body.append(blank)
    cleanupIframeRouting = installBrowserIframeClickedLinkRouting(FOREGROUND_FRAME_NAME, true, true)

    expect(clickLink(blank, { metaKey: true }).open).toHaveBeenCalledWith(
      'https://example.com/new-context',
      FOREGROUND_FRAME_NAME
    )

    cleanupIframeRouting = installBrowserIframeClickedLinkRouting(FOREGROUND_FRAME_NAME, true, true)
    expect(clickLink(blank, { type: 'auxclick' }).open).toHaveBeenCalledWith(
      'https://example.com/new-context',
      FOREGROUND_FRAME_NAME
    )

    cleanupIframeRouting = installBrowserIframeClickedLinkRouting(FOREGROUND_FRAME_NAME, true, true)
    expect(clickLink(blank, { metaKey: true, shiftKey: true }).open).toHaveBeenCalledWith(
      'https://example.com/new-context',
      FOREGROUND_FRAME_NAME
    )
  })

  it('leaves other-platform, Shift-window, and ordinary iframe clicks to Chromium', () => {
    const blank = document.createElement('a')
    blank.href = 'https://example.com/new-context'
    blank.target = '_blank'
    const ordinary = document.createElement('a')
    ordinary.href = 'https://example.com/current'
    document.body.append(blank, ordinary)
    cleanupIframeRouting = installBrowserIframeClickedLinkRouting(FOREGROUND_FRAME_NAME, true, true)

    expect(clickLink(blank, { ctrlKey: true }).open).not.toHaveBeenCalled()
    expect(clickLink(blank, { shiftKey: true }).open).not.toHaveBeenCalled()
    expect(clickLink(ordinary).open).not.toHaveBeenCalled()
  })

  it('ignores synthetic main-frame and iframe clicks in production mode', () => {
    const mainLink = document.createElement('a')
    mainLink.href = 'https://example.com/main-synthetic'
    const frameLink = document.createElement('a')
    frameLink.href = 'https://example.com/frame-synthetic'
    frameLink.target = '_blank'
    document.body.append(mainLink, frameLink)
    installBrowserClickedLinkRouting(FOREGROUND_FRAME_NAME, true)
    cleanupIframeRouting = installBrowserIframeClickedLinkRouting(FOREGROUND_FRAME_NAME, true)

    expect(clickLink(mainLink, { metaKey: true }).open).not.toHaveBeenCalled()
    expect(clickLink(frameLink).open).not.toHaveBeenCalled()
    expect(frameLink.getAttribute('target')).toBe('_blank')
  })

  it('builds a self-contained iframe script with per-frame routing tokens', () => {
    const script = buildBrowserIframeClickedLinkRoutingScript(FOREGROUND_FRAME_NAME, false)

    expect(script).toContain('installBrowserIframeClickedLinkRouting')
    expect(script).toContain(`"${FOREGROUND_FRAME_NAME}",false`)
  })
})
