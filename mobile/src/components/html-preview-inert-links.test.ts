// @vitest-environment happy-dom
// Assert absent link semantics (underline/pointer/dead anchor, ruling 37.2); real Chromium/WebKit rendering lives in mobile-web-app-html-preview-render.test.mjs.
// happy-dom has no UA styles/cursor; browser rig cannot identify removed attributes, so both suites are needed.
import { describe, expect, it } from 'vitest'
import { htmlPreviewWithInertLinks } from './html-preview-inert-links'

/** The rewritten document, re-parsed, so every case reads a tree rather than a string. */
function inert(html: string): Document {
  return new DOMParser().parseFromString(htmlPreviewWithInertLinks(html), 'text/html')
}

const ARTIFACT =
  '<!doctype html><html><head><title>A</title></head><body>' +
  '<h1 id="marker">text</h1>' +
  '<a id="top" href="https://example.com/a" target="_top">tap</a>' +
  '<a id="blank" href="https://example.com/b" target="_blank">window</a>' +
  '<a id="root" href="/">root</a>' +
  '<a id="empty" href="">empty</a>' +
  '<a id="frag" href="#target" target="_top">contents</a>' +
  '<h2 id="target">T</h2>' +
  '<a id="named" name="anchor">named</a>' +
  '<img id="mapped" src="x.png" usemap="#m" />' +
  '<map name="m"><area id="area" href="https://example.com/c" shape="rect" coords="0,0,1,1" /></map>' +
  '<svg viewBox="0 0 1 1"><a id="svglink" href="https://example.com/d"><rect /></a></svg>' +
  '</body></html>'

describe('an artifact rendered for a shell that cannot open a link', () => {
  it('leaves no element a browser would treat as a link', () => {
    // Remove href so a:any-link no longer matches, disabling underline/pointer/activation together.
    expect(inert(ARTIFACT).querySelectorAll('a[href], area[href]')).toHaveLength(0)
  })

  // In srcdoc, #target resolves against inherited shell base, not about:srcdoc, becoming forbidden frame navigation instead of scrolling.
  // Chromium 147/WebKit 26.4 probes reported frame-src; Chromium replaced artifact with error page. Keep fragment links inert too.
  it('inerts a fragment link too, because a fragment is not a scroll in this frame', () => {
    const doc = inert(ARTIFACT)
    expect(doc.getElementById('frag')?.hasAttribute('href')).toBe(false)
    expect(doc.getElementById('frag')?.hasAttribute('target')).toBe(false)
    // The text and the target it named both stay, as everywhere else: hidden, not deleted.
    expect(doc.getElementById('frag')?.textContent).toBe('contents')
    expect(doc.getElementById('target')?.textContent).toBe('T')
    // And the empty href, which resolves to the frame's own URL rather than to a fragment at all.
    expect(doc.getElementById('empty')?.hasAttribute('href')).toBe(false)
  })

  it('keeps the text, the headings and the images the author wrote', () => {
    const doc = inert(ARTIFACT)
    expect(doc.getElementById('marker')?.textContent).toBe('text')
    expect(doc.getElementById('top')?.textContent).toBe('tap')
    expect(doc.getElementById('blank')?.textContent).toBe('window')
    expect(doc.getElementById('mapped')?.getAttribute('src')).toBe('x.png')
    expect(doc.title).toBe('A')
    // The elements are still there and still in order: this is a hidden affordance, not a deletion.
    expect([...doc.querySelectorAll('a')].map((one) => one.id)).toEqual([
      'top',
      'blank',
      'root',
      'empty',
      'frag',
      'named',
      'svglink'
    ])
  })

  it('drops the target with the href, so no non-link carries link markup', () => {
    const doc = inert(ARTIFACT)
    expect(doc.getElementById('top')?.hasAttribute('target')).toBe(false)
    expect(doc.getElementById('blank')?.hasAttribute('target')).toBe(false)
  })

  it('reaches an image map and an SVG link, which a pass over `a[href]` alone would not', () => {
    const doc = inert(ARTIFACT)
    expect(doc.getElementById('area')?.hasAttribute('href')).toBe(false)
    // Still an area with its shape: the map is intact, it just goes nowhere.
    expect(doc.getElementById('area')?.getAttribute('shape')).toBe('rect')
    expect(doc.getElementById('svglink')?.hasAttribute('href')).toBe(false)
  })

  it('leaves an anchor that was never a link alone, which is most of what a document has', () => {
    // `<a name>` has no href to begin with, so nothing here should have changed about it.
    expect(inert(ARTIFACT).getElementById('named')?.getAttribute('name')).toBe('anchor')
  })

  // Preserve authored doctype bytes/identifiers; srcdoc inherits embedder’s mode regardless, so test document.doctype rather than CSS1Compat.
  it('keeps the doctype whole, identifiers and all', () => {
    const doctypeOf = (html: string) => htmlPreviewWithInertLinks(html).split('>')[0] ?? ''
    expect(doctypeOf(ARTIFACT).toLowerCase()).toBe('<!doctype html')
    expect(
      doctypeOf('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"><html><body>x')
    ).toBe('<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN"')
    expect(
      htmlPreviewWithInertLinks(
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd"><html><body>x'
      )
    ).toContain(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">'
    )
    // Leave missing doctype absent rather than inventing author markup.
    expect(htmlPreviewWithInertLinks('<html><body>x</body></html>').toLowerCase()).not.toContain(
      '<!doctype'
    )
  })

  // Browser parse drops one leading pre/listing/textarea newline; neither Chromium/WebKit serializer restores it. Reinsert before next parse.
  // Check serialized string here: happy-dom does not drop newline, so only browser render rig can prove round-trip text.
  it('writes back the leading newline the serialiser owes each preformatted block', () => {
    const out = htmlPreviewWithInertLinks(
      '<!doctype html><html><body><pre id="p">\n\nkept</pre>' +
        '<listing>\n\nalso</listing><textarea>\n\nfield</textarea>' +
        '<pre id="q">no newline</pre></body></html>'
    )
    expect(out).toContain('<pre id="p">\n\n\nkept</pre>')
    expect(out).toContain('<listing>\n\n\nalso</listing>')
    expect(out).toContain('<textarea>\n\n\nfield</textarea>')
    // Only a block that starts with one gets one: this is a compensation, not a prefix.
    expect(out).toContain('<pre id="q">no newline</pre>')
  })

  it('does not run or fetch what the artifact carries, because nothing here has a context', () => {
    // DOMParser creates no browsing context; script remains markup without execution.
    const withScript =
      '<!doctype html><html><body><script>window.__ran = 1</script><a href="/x">a</a></body></html>'
    const out = htmlPreviewWithInertLinks(withScript)
    expect(out).toContain('window.__ran = 1')
    expect('__ran' in globalThis).toBe(false)
  })

  it('leaves an href inside a comment where a regex pass would have found it', () => {
    // Use parser rather than regex so href inside comment remains untouched artifact text.
    const doc = inert(
      '<!doctype html><html><body><!-- <a href="https://example.com/x">c</a> -->' +
        '<a id="real" href="https://example.com/z">r</a></body></html>'
    )
    expect(doc.body.innerHTML).toContain('href="https://example.com/x"')
    // The control: a link that is rendered did lose its href.
    expect(doc.getElementById('real')?.hasAttribute('href')).toBe(false)
  })

  // Declarative shadowroot templates become rendered content at frame parse, but DOMParser leaves templates intact on Chromium 147/WebKit 26.4/happy-dom.
  // Traverse template.content recursively: document querySelectorAll misses links that would otherwise become dead anchors under sandbox.
  it('reaches a link inside a declarative shadow root, and inside one nested in it', () => {
    const doc = inert(
      '<!doctype html><html><body><div id="host">' +
        '<template shadowrootmode="open">' +
        '<a id="shadow" href="https://example.com/s" target="_top">s</a>' +
        '<div><template shadowrootmode="open">' +
        '<a id="deep" href="https://example.com/d">d</a>' +
        '<a id="deepfrag" href="#inside">f</a>' +
        '</template></div>' +
        '</template></div></body></html>'
    )
    const outer = doc.querySelector('template')?.content
    expect(outer?.getElementById('shadow')?.hasAttribute('href')).toBe(false)
    expect(outer?.getElementById('shadow')?.hasAttribute('target')).toBe(false)
    // The text is still there, as everywhere else: hidden, not deleted.
    expect(outer?.getElementById('shadow')?.textContent).toBe('s')
    const inner = outer?.querySelector('template')?.content
    expect(inner?.getElementById('deep')?.hasAttribute('href')).toBe(false)
    // Including the fragment one, at every depth.
    expect(inner?.getElementById('deepfrag')?.hasAttribute('href')).toBe(false)
  })
})
