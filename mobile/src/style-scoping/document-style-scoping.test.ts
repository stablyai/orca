import { describe, expect, it } from 'vitest'
import {
  documentLevelRules,
  isDocumentLevelSelector,
  scopeDocumentStyleToHost,
  scopeStyleToHost
} from './document-style-scoping'

/**
 * The rewrite's own contract, with no caller's sheet in it.
 *
 * Each page mount holds the rewrite against the sheet it actually injects — the terminal in
 * `terminal/terminal-webview-html/document-style.test.ts`, the editor in
 * `components/rich-markdown/page-stylesheet.test.ts`. What is left here is what neither of them
 * owns: which selectors read as the document's own, and the shapes the textual rewrite refuses
 * rather than passing a rule through unscoped.
 */
const PREFIX = '.host'

describe('a stylesheet held under a host element', () => {
  it('reads a document-level selector wherever the list puts it', () => {
    expect(isDocumentLevelSelector('body')).toBe(true)
    expect(isDocumentLevelSelector('html, body')).toBe(true)
    expect(isDocumentLevelSelector('*')).toBe(true)
    expect(isDocumentLevelSelector('#terminal-container')).toBe(false)
    expect(isDocumentLevelSelector('.xterm .xterm-viewport')).toBe(false)
    expect(documentLevelRules('* { margin: 0; }\n.a { color: red; }')).toEqual(['*'])
  })

  it('refuses a sheet whose shape it cannot rewrite, through either export', () => {
    // The rewrite is textual because the input is flat. A sheet that grew an at-rule would have
    // its inner selectors passed through unscoped, so both exports throw instead.
    for (const scope of [scopeStyleToHost, scopeDocumentStyleToHost]) {
      expect(() => scope('@media (min-width: 1px) { .a { color: red; } }', PREFIX)).toThrow(
        'at-rules cannot be scoped'
      )
      expect(() => scope('.a { color: red;', PREFIX)).toThrow('never closes')
      expect(() => scope('{ color: red; }', PREFIX)).toThrow('no selector')
    }
  })
})
