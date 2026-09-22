import { describe, expect, it } from 'vitest'
import { scopeDocumentStyleToHost } from '../../style-scoping/document-style-scoping'
import { richMarkdownEditorStyle } from './document-style'

/**
 * The editor's sheet, held under the element the page mounts it in.
 *
 * Inside the WebView the document owns its page, so the sheet says `:root`, `*`, `html` and `body`
 * and means all four. Appended to the head of a React Native Web application those four restyle
 * every screen the shell can show, so ruling 19's rule for `window.onerror` applies to CSS: the
 * page mount may style only what it owns.
 *
 * Where this differs from the terminal's half is what happens to those four. The terminal drops
 * them and repaints through a seam, because the colour it was setting belongs to the application.
 * The editor has no such seam and needs none: the host element *is* the editor's page, so the
 * document's own rules move onto it — the variables the whole sheet reads, the surface colour, the
 * font, the box model — and a bare `p` or `code` still reaches only what is inside it.
 */
const PREFIX = '.orca-rich-markdown-document-host'

/** Every selector in a sheet, one per entry, as the rewrite leaves them. */
function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((match) =>
    match[1]!.split(',').map((one) => one.trim())
  )
}

describe('the editor stylesheet on the page', () => {
  it('reaches nothing outside the host', () => {
    const selectors = selectorsOf(scopeDocumentStyleToHost(richMarkdownEditorStyle(), PREFIX))
    expect(selectors.length).toBeGreaterThan(40)
    expect(selectors.filter((one) => one !== PREFIX && !one.startsWith(`${PREFIX} `))).toEqual([])
  })

  it('moves the document’s own rules onto the host rather than dropping them', () => {
    const scoped = scopeDocumentStyleToHost(richMarkdownEditorStyle(), PREFIX)
    // The variables every other rule reads. Dropped, the sheet would render unstyled while every
    // selector in it still looked correctly scoped.
    expect(scoped).toContain('--foreground:')
    const rootRules = scoped
      .split('}')
      .filter((rule) => rule.includes('--foreground:') || rule.includes('overscroll-behavior:'))
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
    // `.host body p` matches nothing and `.host p` is not what `body p` said. Either reading is a
    // silent change to the sheet, so the shape is refused instead.
    expect(() => scopeDocumentStyleToHost('body p { color: red; }', PREFIX)).toThrow(
      'cannot be moved onto a host'
    )
  })

  it('refuses a descendant of the document root, which reads as no leading element at all', () => {
    // `:root` starts with a colon, so the leading-element read answers the empty string and the
    // selector fell through to `.host :root .foo` — a rule that matches nothing, silently.
    for (const selector of [':root .foo', ':root > .foo', ':root.theme']) {
      expect(() => scopeDocumentStyleToHost(`${selector} { color: red; }`, PREFIX)).toThrow(
        'cannot be moved onto a host'
      )
    }
    // The bare name is still the host itself, which is the case the sheet actually has.
    expect(scopeDocumentStyleToHost(':root { color: red; }', PREFIX)).toContain(`${PREFIX} {`)
  })

  it('refuses a sheet whose shape it cannot rewrite, as the other half does', () => {
    expect(() =>
      scopeDocumentStyleToHost('@media (min-width: 1px) { .a { color: red; } }', PREFIX)
    ).toThrow('at-rules cannot be scoped')
    expect(() => scopeDocumentStyleToHost('.a { color: red;', PREFIX)).toThrow('never closes')
  })
})
