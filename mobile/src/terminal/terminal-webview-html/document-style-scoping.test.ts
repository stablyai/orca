import { describe, expect, it } from 'vitest'
import { XTERM_ENGINE_CSS } from '../terminal-webview-engine-css.generated'
import {
  TERMINAL_DOCUMENT_ELEMENT_STYLE,
  TERMINAL_DOCUMENT_ROOT_STYLE,
  TERMINAL_DOCUMENT_STYLE
} from './document-style'
import {
  documentLevelRules,
  isDocumentLevelSelector,
  scopeStyleToHost
} from './document-style-scoping'

/**
 * What the page is allowed to inject, and what the split leaves the WebView.
 *
 * The document's sheet says `*`, `html` and `body` because inside a WebView it owns the page.
 * Appended to the head of a React Native Web application it owns nothing and restyles everything,
 * including after the terminal is gone. So the page takes the element half and holds every
 * selector under its host; these are the two halves of that claim, measured rather than asserted
 * in prose.
 */
const PREFIX = '.orca-terminal-document-host'

function selectorsOf(css: string): string[] {
  return [...css.matchAll(/(?:^|\})\s*([^{}]+)\{/g)].flatMap((match) =>
    match[1]!.split(',').map((one) => one.trim())
  )
}

describe('the terminal document stylesheet', () => {
  it('splits into two halves that still compose the sheet the WebView carries', () => {
    // The native document must not move for the split, which is what the byte golden says; this
    // is the same claim one level down, where a reordering would be visible as text.
    expect(TERMINAL_DOCUMENT_STYLE).toBe(
      `${TERMINAL_DOCUMENT_ROOT_STYLE}\n${TERMINAL_DOCUMENT_ELEMENT_STYLE}`
    )
  })

  it('keeps every document-level rule out of the half the page takes', () => {
    expect(documentLevelRules(TERMINAL_DOCUMENT_ROOT_STYLE)).toEqual(['*', 'html, body'])
    expect(documentLevelRules(TERMINAL_DOCUMENT_ELEMENT_STYLE)).toEqual([])
    // The precondition for the empty list: the reader does find them when they are there.
    expect(isDocumentLevelSelector('body')).toBe(true)
    expect(isDocumentLevelSelector('html, body')).toBe(true)
    expect(isDocumentLevelSelector('*')).toBe(true)
    expect(isDocumentLevelSelector('#terminal-container')).toBe(false)
    expect(isDocumentLevelSelector('.xterm .xterm-viewport')).toBe(false)
  })

  it('holds every selector of both injected sheets under the host', () => {
    for (const sheet of [TERMINAL_DOCUMENT_ELEMENT_STYLE, XTERM_ENGINE_CSS]) {
      const scoped = scopeStyleToHost(sheet, PREFIX)
      const selectors = selectorsOf(scoped)
      expect(selectors.length).toBeGreaterThan(0)
      expect(selectors.filter((one) => !one.startsWith(`${PREFIX} `))).toEqual([])
    }
  })

  it('drops a document-level rule rather than prefixing it', () => {
    // `.host *` is not what `*` meant, and a page has no use for either reading.
    const scoped = scopeStyleToHost(TERMINAL_DOCUMENT_ROOT_STYLE, PREFIX)
    expect(scoped.trim()).toBe('')
  })

  it('refuses a sheet whose shape it cannot rewrite', () => {
    // The rewrite is textual because the input is flat. A sheet that grew an at-rule would have
    // its inner selectors passed through unscoped, so it throws instead.
    expect(() =>
      scopeStyleToHost('@media (min-width: 1px) { .a { color: red; } }', PREFIX)
    ).toThrow('at-rules cannot be scoped')
    expect(() => scopeStyleToHost('.a { color: red;', PREFIX)).toThrow('never closes')
  })
})
