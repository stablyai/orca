// Remove a/area hrefs so links become text: no underline, pointer, tab stop or dead activation (ruling 37.2); preserve all other rendering.
// Use inert DOMParser (no script/fetch/layout), never regex; compensate lossy round-trip details below and test both structure and browser rendering.
// Remove fragment links too: srcdoc’s inherited base resolves them away from about:srcdoc; Chromium 147/WebKit 26.4 block frame navigation rather than scroll, sometimes replacing artifact.
// Granted path has same existing fragment bug, tracked in followup-html-preview-fragment-links.md.
// Also remove sandbox’s allow-top-navigation-by-user-activation: parser hides affordance, sandbox blocks any missed navigation; neither fence replaces other.

/** `Node.TEXT_NODE`, named here so this module reads one global fewer. */
const TEXT_NODE = 3

// Include image-map area and SVG namespaced href targets, not just plain HTML anchors.
const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink'

// Preserve authored doctype identifiers, observable beside Source; srcdoc inherits embedder mode regardless (Chromium 147/WebKit 26.4).
// Choose quote character because single-quoted identifiers may contain double quotes.
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

// Restore leading newline before pre/listing/textarea reparse: Chromium 147/WebKit 26.4 serializers omit required compensation and lose blank line.
// Real render rig is oracle; happy-dom parser never drops first newline and cannot prove browser round-trip fidelity.
function restoreLeadingNewlines(root: Document | DocumentFragment): void {
  for (const block of root.querySelectorAll('pre, listing, textarea')) {
    const first = block.firstChild
    if (first?.nodeType === TEXT_NODE && first.nodeValue?.startsWith('\n') === true) {
      first.nodeValue = `\n${first.nodeValue}`
    }
  }
}

// Recurse template.content, which querySelectorAll skips: DOMParser leaves declarative shadowroot templates intact, but frame parser renders their links.
// Templates can nest; missed links would remain dead navigation affordances under sandbox.
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
