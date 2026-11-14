import { describe, expect, it } from 'vitest'
import { scopeDocumentStyleToHost } from '../../style-scoping/document-style-scoping'

const PREFIX = '.orca-rich-markdown-document-host'

describe('the editor stylesheet on the page', () => {
  it('refuses a document-level selector it cannot move, rather than scoping it wrongly', () => {
    // Refuse compound host-global selector rather than silently rewriting body p into mismatching .host body p or changed .host p.
    expect(() => scopeDocumentStyleToHost('body p { color: red; }', PREFIX)).toThrow(
      'cannot be moved onto a host'
    )
  })

  it('refuses a descendant of the document root, which reads as no leading element at all', () => {
    // Handle :root explicitly; leading-element parser sees empty name and would produce silent nonmatching .host :root .foo.
    for (const selector of [':root .foo', ':root > .foo', ':root.theme']) {
      expect(() => scopeDocumentStyleToHost(`${selector} { color: red; }`, PREFIX)).toThrow(
        'cannot be moved onto a host'
      )
    }
    // The bare name is still the host itself, which is the case the sheet actually has.
    expect(scopeDocumentStyleToHost(':root { color: red; }', PREFIX)).toContain(`${PREFIX} {`)
  })
})
