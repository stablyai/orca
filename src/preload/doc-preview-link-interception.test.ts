// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DOC_PREVIEW_LINK_CLICK_CHANNEL } from '../shared/doc-preview-scheme'
import {
  handleDocPreviewLinkAuxClick,
  handleDocPreviewLinkClick,
  installDocPreviewLinkInterception,
  PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL
} from './doc-preview-link-interception'

const PREVIEW_GRANT_ID = 'a'.repeat(32)

let report: ReturnType<typeof vi.fn<(url: string) => void>>

function documentUrl(): string {
  return window.location.href
}

function loadPreviewDocument(body: string): void {
  document.body.innerHTML = body
  report = vi.fn<(url: string) => void>()
}

// happy-dom does not model SVGAnimatedString hrefs.
function loadSvgAnchorDocument(href: string): void {
  loadPreviewDocument('<div id="host"></div>')
  const svgNamespace = 'http://www.w3.org/2000/svg'
  const anchor = document.createElementNS(svgNamespace, 'a')
  anchor.setAttribute('href', href)
  Object.defineProperty(anchor, 'href', { value: { baseVal: href } })
  const hit = document.createElementNS(svgNamespace, 'rect')
  hit.setAttribute('id', 'svg-hit')
  anchor.appendChild(hit)
  const svg = document.createElementNS(svgNamespace, 'svg')
  svg.appendChild(anchor)
  document.getElementById('host')!.appendChild(svg)
}

function dispatch(selector: string, event: MouseEvent): MouseEvent {
  const onClick = (candidate: Event): void => handleDocPreviewLinkClick(candidate, report)
  const onAuxClick = (candidate: Event): void =>
    handleDocPreviewLinkAuxClick(candidate as MouseEvent)
  document.addEventListener('click', onClick, true)
  document.addEventListener('auxclick', onAuxClick, true)
  try {
    document.querySelector(selector)!.dispatchEvent(event)
  } finally {
    document.removeEventListener('click', onClick, true)
    document.removeEventListener('auxclick', onAuxClick, true)
  }
  return event
}

function pressTrusted(selector: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })
  return dispatch(selector, event)
}

beforeEach(() => {
  ;(window as never as { happyDOM: { setURL: (url: string) => void } }).happyDOM.setURL(
    `orca-preview://${PREVIEW_GRANT_ID}/index.html`
  )
  vi.restoreAllMocks()
})

describe('doc preview link interception', () => {
  it('sends on exactly the channel main listens on', () => {
    expect(PRELOAD_DOC_PREVIEW_LINK_CLICK_CHANNEL).toBe(DOC_PREVIEW_LINK_CLICK_CHANNEL)
  })

  it('listens for both press kinds in the capture phase, so the document cannot consume them first', () => {
    loadPreviewDocument('<a id="external" href="https://example.com/docs">go</a>')
    const addEventListener = vi.spyOn(document, 'addEventListener')
    try {
      installDocPreviewLinkInterception(report)
      expect(addEventListener.mock.calls.map(([type, , options]) => [type, options])).toEqual([
        ['click', true],
        ['auxclick', true]
      ])
      const link = document.querySelector('#external')!
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      Object.defineProperty(click, 'isTrusted', { configurable: true, value: true })
      link.dispatchEvent(click)
      expect(report).toHaveBeenCalledExactlyOnceWith('https://example.com/docs')
      expect(click.defaultPrevented).toBe(true)

      const middleClick = new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })
      Object.defineProperty(middleClick, 'isTrusted', { configurable: true, value: true })
      link.dispatchEvent(middleClick)
      expect(middleClick.defaultPrevented).toBe(true)
      expect(report).toHaveBeenCalledOnce()
    } finally {
      for (const [type, listener, options] of addEventListener.mock.calls) {
        document.removeEventListener(type, listener, options)
      }
    }
  })

  it('routes nothing for a click the document dispatched itself', () => {
    loadPreviewDocument('<a id="external" href="https://attacker.test/?d=secret">go</a>')

    const scripted = new MouseEvent('click', { bubbles: true, cancelable: true })
    // happy-dom omits the isTrusted value Chromium sets for synthetic clicks.
    Object.defineProperty(scripted, 'isTrusted', { configurable: true, value: false })

    const event = dispatch('#external', scripted)

    expect(event.isTrusted).toBe(false)
    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('reports a trusted press on an external anchor exactly once and stops the navigation', () => {
    loadPreviewDocument('<a id="external" href="https://example.com/docs">go</a>')

    const event = pressTrusted('#external')

    expect(report).toHaveBeenCalledExactlyOnceWith('https://example.com/docs')
    expect(event.defaultPrevented).toBe(true)
  })

  it('reports the anchor even when the press landed on what it wraps', () => {
    loadPreviewDocument('<a href="https://example.com/docs"><span id="inner">go</span></a>')

    pressTrusted('#inner')

    expect(report).toHaveBeenCalledExactlyOnceWith('https://example.com/docs')
  })

  it('reports an SVG anchor by its animated href', () => {
    loadSvgAnchorDocument('https://example.com/chart')

    pressTrusted('#svg-hit')

    expect(report).toHaveBeenCalledExactlyOnceWith('https://example.com/chart')
  })

  it('leaves a relative SVG link to the guest, the same as the HTML anchor beside it', () => {
    loadSvgAnchorDocument('guide.html')

    const event = pressTrusted('#svg-hit')

    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('scrolls to an SVG fragment target instead of routing it', () => {
    loadSvgAnchorDocument('#section-2')
    const target = document.createElement('h2')
    target.id = 'section-2'
    document.body.appendChild(target)
    const scrollIntoView = vi.spyOn(target, 'scrollIntoView')

    const event = pressTrusted('#svg-hit')

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('scrolls to the top for a bare # on an SVG anchor', () => {
    loadSvgAnchorDocument('#')
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    pressTrusted('#svg-hit')

    expect(scrollTo).toHaveBeenCalledOnce()
    expect(report).not.toHaveBeenCalled()
  })

  it('keeps a rooted SVG link inside the preview rather than reading it as a filesystem path', () => {
    loadSvgAnchorDocument('/assets/a.html')

    const event = pressTrusted('#svg-hit')

    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('leaves a sibling preview document to the guest, which its policy already permits', () => {
    loadPreviewDocument(
      `<a id="sibling" href="orca-preview://${PREVIEW_GRANT_ID}/guide.html">guide</a>`
    )

    const event = pressTrusted('#sibling')

    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })

  it('scrolls to a fragment target in the document instead of routing it', () => {
    loadPreviewDocument(
      `<a id="jump" href="${documentUrl()}#section">jump</a><h2 id="section">s</h2>`
    )
    const scrollIntoView = vi.spyOn(document.getElementById('section')!, 'scrollIntoView')

    const event = pressTrusted('#jump')

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('finds a fragment target whose id the href percent-encoded', () => {
    loadPreviewDocument(`<a id="jump" href="${documentUrl()}#a%20b">jump</a><h2 id="a b">s</h2>`)
    const scrollIntoView = vi.spyOn(document.getElementById('a b')!, 'scrollIntoView')

    pressTrusted('#jump')

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(report).not.toHaveBeenCalled()
  })

  it('scrolls to the top for a bare # and for #top with nothing carrying that id', () => {
    loadPreviewDocument(
      `<a id="hash" href="#">top</a><a id="named" href="${documentUrl()}#top">top</a>`
    )
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})

    pressTrusted('#hash')
    pressTrusted('#named')

    expect(scrollTo).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
  })

  it('routes a fragment href that belongs to another document', () => {
    loadPreviewDocument('<a id="other" href="https://example.com/page#section">go</a>')

    pressTrusted('#other')

    expect(report).toHaveBeenCalledExactlyOnceWith('https://example.com/page#section')
  })

  it('opens nothing for a middle click on a link', () => {
    loadPreviewDocument('<a id="external" href="https://example.com/docs">go</a>')
    const event = new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })
    Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })

    dispatch('#external', event)

    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a middle click the document dispatched itself alone', () => {
    loadPreviewDocument('<a id="external" href="https://example.com/docs">go</a>')
    const event = new MouseEvent('auxclick', { bubbles: true, button: 1, cancelable: true })
    Object.defineProperty(event, 'isTrusted', { configurable: true, value: false })

    dispatch('#external', event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('ignores a press that is not on a link at all', () => {
    loadPreviewDocument('<p id="text">nothing here</p>')

    const event = pressTrusted('#text')

    expect(report).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
