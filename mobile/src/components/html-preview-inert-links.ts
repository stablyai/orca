/**
 * The artifact with its links turned back into text, for a shell that cannot open one.
 *
 * Ruling 37.2 is the specification: no underline, no pointer, and no dead anchor a tap does nothing
 * on. Removing `href` is what delivers all three at once, because it is what the HTML definition of
 * a link turns on -- `a:any-link` stops matching, so the UA stylesheet stops underlining and stops
 * setting the pointer cursor, the element leaves the tab order, and activating it does nothing
 * because there is nothing to activate. The text the author wrote stays exactly where it was, which
 * is what makes this a hidden affordance rather than a degraded screen.
 *
 * Round 2's ruling is the tighter one this file is written against: this path may change nothing
 * about the artifact's rendering except that links are not links. A parse and a reserialise is not
 * free of that by default, so the three places it was measured to be lossy are compensated below
 * and pinned in two suites -- the shapes in `html-preview-inert-links.test.ts`, and what an engine
 * then renders in `config/scripts/mobile-web-app-html-preview-render.test.mjs`.
 *
 * A `#`-prefixed link is not an exception to that, and round 3 measured why. Inside this frame a
 * fragment is not a scroll: the document's URL is `about:srcdoc` while its base URL is inherited
 * from the embedder, so `#section` resolves against the shell's own URL and the destination differs
 * from the document's URL by more than a fragment -- which makes activating it a frame navigation
 * rather than a same-document one. Measured on Chromium 147 and WebKit 26.4 under the shipped
 * policy: the tap scrolls nothing (`scrollY` stays 0), the embedder reports
 * `frame-src http://<origin>/preview`, and on Chromium the frame is replaced by
 * `chrome-error://chromewebdata/` -- the artifact is gone. So there is no working affordance to
 * preserve, and keeping the href would have left a live link that destroys the preview, which is
 * worse than the inert text it was carved out to avoid.
 *
 * The same tap does the same thing on the granted path, where this pass does not run at all. That
 * is a bug the preview has always had and it is not this one's to fix; it is recorded in
 * `followup-html-preview-fragment-links.md`.
 *
 * Done with the browser's own parser rather than over the string, and this is the one mechanism
 * available. The frame has no `allow-scripts` and inherits `script-src 'self'`, so nothing runs
 * inside it and there is no injection to do the work there; a regex over the source would have to
 * decide what is an attribute inside an artifact written by an agent, and the two answers that
 * matter -- an `href` inside a comment or a `<template>`, and an `href` the pass failed to see --
 * are both wrong in a way nothing downstream could notice. `parseFromString` builds a document with
 * no browsing context: no script runs, no subresource is fetched, nothing is laid out.
 *
 * Belt and braces with the sandbox: the frame also loses
 * `allow-top-navigation-by-user-activation` on this path, so a link this pass somehow missed is
 * refused by the browsing context as well. Neither fence is the other's excuse -- the sandbox alone
 * would leave the dead anchor the ruling forbids, and this alone would leave a document whose
 * context could still navigate the top frame.
 */

/** `Node.TEXT_NODE`, named here so this module reads one global fewer. */
const TEXT_NODE = 3

/** `<area>` as well as `<a>`, because an image map is a link with a shape instead of a box, and
 *  this namespace as well as the plain attribute, because that is how an `<a>` inside inline SVG
 *  spells its target. */
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'

/**
 * The doctype as it was written, identifiers and all.
 *
 * Not for the reason it looks like, and the difference is measured rather than reasoned. The
 * identifiers are what a parser reads the rendering mode from in general -- a standalone document
 * with `<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN">` is quirks and the bare
 * name is not -- but this frame is a `srcdoc`, and a `srcdoc` document takes its mode from its
 * embedder whatever its own doctype says. Measured on Chromium 147 and WebKit 26.4: that doctype,
 * the bare name, and no doctype at all all read `CSS1Compat` inside the frame. So rewriting one as
 * the other cannot move this artifact between layout modes.
 *
 * What it does do is rewrite the document the author wrote, for no reason: `document.doctype` is
 * observable, the Source tab shows the original beside it, and this pass exists to change links and
 * nothing else. That is the whole argument for carrying the identifiers through.
 *
 * The quote character is chosen rather than fixed: the tokenizer admits a single-quoted identifier,
 * whose text may then contain a double quote that would end the string early here.
 */
function serializeDoctype(doctype: DocumentType | null): string {
  if (doctype === null) {
    return ''
  }
  const quoted = (value: string) => (value.includes('"') ? `'${value}'` : `"${value}"`)
  if (doctype.publicId !== '' && doctype.systemId !== '') {
    return `<!DOCTYPE ${doctype.name} PUBLIC ${quoted(doctype.publicId)} ${quoted(doctype.systemId)}>`
  }
  if (doctype.publicId !== '') {
    return `<!DOCTYPE ${doctype.name} PUBLIC ${quoted(doctype.publicId)}>`
  }
  if (doctype.systemId !== '') {
    return `<!DOCTYPE ${doctype.name} SYSTEM ${quoted(doctype.systemId)}>`
  }
  return `<!DOCTYPE ${doctype.name}>`
}

/**
 * The newline the next parse will eat, put back before it does.
 *
 * A parser drops one `U+000A` immediately after a `pre`, `listing` or `textarea` start tag, and the
 * HTML serialiser is specified to put it back. Measured, neither engine's serialiser does
 * (Chromium 147 and WebKit 26.4 both write `<pre>\nfoo</pre>` for a text node of `"\nfoo"`, which
 * reparses as `"foo"`), so a round trip through them loses one blank line from every such block.
 * This writes the extra newline the serialiser owes, and the same measurement says the doubled one
 * survives the reparse exactly.
 *
 * The rendered text is the oracle, and it lives in the render rig: this module's own suite runs in
 * happy-dom, whose parser does not drop the newline in the first place, so a round-trip assertion
 * there would measure that parser rather than a browser's.
 */
function restoreLeadingNewlines(root: Document | DocumentFragment): void {
  for (const block of root.querySelectorAll('pre, listing, textarea')) {
    const first = block.firstChild
    if (first?.nodeType === TEXT_NODE && first.nodeValue?.startsWith('\n') === true) {
      first.nodeValue = `\n${first.nodeValue}`
    }
  }
}

/**
 * Every link in one tree, and then every tree a `<template>` holds.
 *
 * `querySelectorAll` does not walk into `template.content`, which is its own fragment, and a
 * template is not always inert markup: `<template shadowrootmode>` is a declarative shadow root, and
 * the frame's parser attaches it on parse and renders what is inside. Measured, `parseFromString`
 * does not attach one (Chromium 147, WebKit 26.4 and happy-dom all leave the template standing), so
 * this pass can reach the links there -- and must, or they arrive in the frame as live links inside
 * a sandbox that refuses their navigation, which is exactly the dead anchor ruling 37.2 forbids.
 *
 * Recursive rather than one flat query, because a template may hold a template.
 */
function inertLinksIn(root: Document | DocumentFragment): void {
  for (const link of root.querySelectorAll('a, area')) {
    link.removeAttribute('href')
    link.removeAttributeNS(XLINK_NAMESPACE, 'href')
    link.removeAttribute('target')
  }
  restoreLeadingNewlines(root)
  for (const template of root.querySelectorAll('template')) {
    inertLinksIn(template.content)
  }
}

export function htmlPreviewWithInertLinks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  inertLinksIn(doc)
  return `${serializeDoctype(doc.doctype)}${doc.documentElement.outerHTML}`
}
