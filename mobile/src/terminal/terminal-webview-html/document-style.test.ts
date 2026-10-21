import { describe, expect, it } from 'vitest'
import { documentLevelRules, scopeStyleToHost } from '../../style-scoping/document-style-scoping'
import { XTERM_ENGINE_CSS } from '../terminal-webview-engine-css.generated'
import {
  TERMINAL_DOCUMENT_ELEMENT_STYLE,
  TERMINAL_DOCUMENT_ROOT_STYLE,
  TERMINAL_DOCUMENT_STYLE
} from './document-style'

/**
 * What the page is allowed to inject, and what the split leaves the WebView.
 *
 * The document's sheet says `*`, `html` and `body` because inside a WebView it owns the page.
 * Appended to the head of a React Native Web application it owns nothing and restyles everything,
 * including after the terminal is gone. So the page takes the element half and holds every
 * selector under its host; these are the two halves of that claim, measured rather than asserted
 * in prose.
 *
 * The rewrite's own contract — which selectors read as the document's, and the sheet shapes it
 * refuses — is held beside it in `style-scoping/document-style-scoping.test.ts`.
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
    // The root half is the precondition for the empty list beside it: the reader does find these
    // rules when a sheet has them.
    expect(documentLevelRules(TERMINAL_DOCUMENT_ROOT_STYLE)).toEqual(['*', 'html, body'])
    expect(documentLevelRules(TERMINAL_DOCUMENT_ELEMENT_STYLE)).toEqual([])
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
})
