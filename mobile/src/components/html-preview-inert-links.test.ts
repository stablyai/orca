// @vitest-environment happy-dom
/**
 * The link-inerting pass, read as the specification ruling 37.2 wrote: no underline, no pointer, no
 * dead anchor.
 *
 * All three are one property of the document -- whether the element is a link at all -- so this file
 * measures that property and `config/scripts/mobile-web-app-html-preview-render.test.mjs` measures
 * what a real browser then paints and does with it on both engines. Neither reading substitutes for
 * the other: happy-dom has no UA stylesheet and no cursor, and the render rig cannot say which
 * attribute went.
 */
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
    // The whole of "no underline, no pointer, no dead anchor": all three follow from `a:any-link`
    // not matching, and `href` is what it matches on.
    expect(inert(ARTIFACT).querySelectorAll('a[href], area[href]')).toHaveLength(0)
  })

  /**
   * The fragment link goes too, and round 3 is why: in this frame a fragment is not a scroll.
   *
   * The document's URL is `about:srcdoc` while its base URL is inherited from the embedder, so
   * `#target` resolves against the shell's own URL and the destination differs from the document's
   * by more than a fragment -- which makes activating it a frame navigation. Measured on Chromium
   * 147 and WebKit 26.4 under the shipped policy: nothing scrolls, the embedder reports
   * `frame-src`, and on Chromium the frame is replaced by an error page and the artifact is gone.
   *
   * So there was no working affordance to carve out for. The render rig taps one and reads what
   * the engines do; this is the attribute that decides it.
   */
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

  /**
   * The doctype, whole, because rewriting it is a change this pass has no reason to make.
   *
   * Not because it moves the frame between layout modes: measured, it cannot. A `srcdoc` document
   * takes its rendering mode from its embedder whatever its own doctype says, and on Chromium 147
   * and WebKit 26.4 a quirks doctype, the bare name and no doctype at all all read `CSS1Compat`
   * inside the frame. The reading that does discriminate is the doctype the frame's own document
   * reports, and that is the render rig's case; this is the string it is handed.
   */
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
    // And an artifact that shipped without one still gets none, rather than being handed a mode it
    // was not written for.
    expect(htmlPreviewWithInertLinks('<html><body>x</body></html>').toLowerCase()).not.toContain(
      '<!doctype'
    )
  })

  /**
   * The blank line the next parse will eat, written back before it does.
   *
   * A parser drops one newline after a `pre`, `listing` or `textarea` start tag and the serialiser
   * is specified to put it back; measured, neither engine's does, so a round trip loses a blank
   * line from every such block. This reads the string the pass produces, because happy-dom's own
   * parser does not drop that newline and a round-trip assertion here would measure happy-dom
   * rather than a browser. What an engine renders is the render rig's case.
   */
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
    // The parse is inert by definition (`parseFromString` builds no browsing context), and this is
    // the reading that says the pass did not change that: the script survives as markup, unrun.
    const withScript =
      '<!doctype html><html><body><script>window.__ran = 1</script><a href="/x">a</a></body></html>'
    const out = htmlPreviewWithInertLinks(withScript)
    expect(out).toContain('window.__ran = 1')
    expect('__ran' in globalThis).toBe(false)
  })

  it('leaves an href inside a comment where a regex pass would have found it', () => {
    // The reason this is a parser and not a pattern: a comment is text to a browser, and a pass
    // that rewrote it would be editing the artifact rather than its links.
    const doc = inert(
      '<!doctype html><html><body><!-- <a href="https://example.com/x">c</a> -->' +
        '<a id="real" href="https://example.com/z">r</a></body></html>'
    )
    expect(doc.body.innerHTML).toContain('href="https://example.com/x"')
    // The control: a link that is rendered did lose its href.
    expect(doc.getElementById('real')?.hasAttribute('href')).toBe(false)
  })

  /**
   * A template is not always inert markup, and that is what this case is about.
   *
   * `<template shadowrootmode>` is a declarative shadow root: the frame's parser attaches it and
   * renders what is inside. Measured, `parseFromString` attaches no such root (Chromium 147,
   * WebKit 26.4 and happy-dom all leave the template standing), so the links are reachable here --
   * and `querySelectorAll` does not walk into `template.content`, so a pass over the document alone
   * hands the frame live links inside a sandbox that refuses their navigation, which is the dead
   * anchor ruling 37.2 forbids.
   */
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
