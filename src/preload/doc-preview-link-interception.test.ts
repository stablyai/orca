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

/** The URL the guest is actually on, which is what decides whether an href is a pure fragment. */
function documentUrl(): string {
  return window.location.href
}

function loadPreviewDocument(body: string): void {
  document.body.innerHTML = body
  report = vi.fn<(url: string) => void>()
}

/**
 * An SVG anchor around a hit target, built rather than parsed: the href is an SVGAnimatedString
 * carrying the raw attribute, which is what a plain string read misses and the environment does
 * not model.
 */
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

/**
 * Dispatches through the same capture-phase listener the preload installs, but registered for one
 * press only — a document-level listener left behind would answer every later test's clicks too.
 */
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

/** Chromium's own press. Nothing a document can dispatch carries this. */
function pressTrusted(selector: string, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'isTrusted', { configurable: true, value: true })
  return dispatch(selector, event)
}

beforeEach(() => {
  // Why: the module decides "sibling document" and "pure fragment" against the URL the guest is
  // really on, which in a preview is always the preview scheme.
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
    // Why not let it register: a document-level listener would survive into every later press here.
    const addEventListener = vi.spyOn(document, 'addEventListener').mockImplementation(() => {})

    installDocPreviewLinkInterception(vi.fn())

    expect(addEventListener.mock.calls.map(([type, , options]) => [type, options])).toEqual([
      ['click', true],
      ['auxclick', true]
    ])
  })

  // Why the headline: this is the whole point of the design. A document that can read its grant
  // must not be able to hand it to a browser tab by synthesizing the reader's click.
  it('routes nothing for a click the document dispatched itself', () => {
    loadPreviewDocument('<a id="external" href="https://attacker.test/?d=secret">go</a>')

    const scripted = new MouseEvent('click', { bubbles: true, cancelable: true })
    // Why set it: this is what Chromium stamps on anything a document dispatches, and the test
    // environment leaves the property off entirely.
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

  // Why: an SVG anchor's href is an SVGAnimatedString, so reading it as a string finds nothing and
  // the link would fall through to the guest's navigation guard and die there.
  it('reports an SVG anchor by its animated href', () => {
    loadSvgAnchorDocument('https://example.com/chart')

    pressTrusted('#svg-hit')

    expect(report).toHaveBeenCalledExactlyOnceWith('https://example.com/chart')
  })

  // Why these three: baseVal is the raw attribute, so an unresolved read sends a relative sibling
  // out to a browser tab, drops SVG fragment links on the floor, and turns a rooted path into a
  // file URL the guest refuses — each one a divergence from the identical HTML anchor.
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
