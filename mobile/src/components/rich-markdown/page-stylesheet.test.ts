import { describe, expect, it } from 'vitest'
import { scopeDocumentStyleToHost } from '../../style-scoping/document-style-scoping'
import { richMarkdownEditorStyle } from './document-style'

// Scope all editor selectors to mount host: native :root/*/html/body rules otherwise restyle whole RN Web app after editor unmount.
// Move globals onto host, including theme variables/color/font/box model; unlike terminal, editor owns these page rules rather than delegating to app seam.
const PREFIX = '.orca-rich-markdown-document-host'

/** Every selector in a sheet, one per entry, as the rewrite leaves them. */
function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((match) =>
    match[1]!.split(',').map((one) => one.trim())
  )
}

describe('the editor stylesheet on the page', () => {
  it('moves the document’s own rules onto the host rather than dropping them', () => {
    const scoped = scopeDocumentStyleToHost(richMarkdownEditorStyle(), PREFIX)
    // Keep theme variables on host or correctly scoped selectors still render unstyled.
    expect(scoped).toContain('--foreground:')
    const rootRules = scoped
      .split('}')
      .filter((rule) => rule.includes('--foreground:') || rule.includes('min-height: 100%'))
    expect(rootRules.length).toBeGreaterThan(0)
    for (const rule of rootRules) {
      expect(rule.trimStart().startsWith(PREFIX)).toBe(true)
    }
  })

  it('keeps the universal rule as the host and everything in it', () => {
    const scoped = scopeDocumentStyleToHost('* { box-sizing: border-box; }', PREFIX)
    expect(selectorsOf(scoped)).toEqual([PREFIX, `${PREFIX} *`])
  })

  it('collapses the document’s three names to one host selector', () => {
    expect(
      selectorsOf(scopeDocumentStyleToHost(':root, html, body { color: red; }', PREFIX))
    ).toEqual([PREFIX])
  })

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
