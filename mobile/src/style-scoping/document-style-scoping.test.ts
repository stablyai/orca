import { describe, expect, it } from 'vitest'
import {
  documentLevelRules,
  isDocumentLevelSelector,
  scopeDocumentStyleToHost,
  scopeStyleToHost
} from './document-style-scoping'

// Test rewrite semantics and refused input shapes here; each page mount separately checks its injected sheet.
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
    // Textual rewriting supports flat sheets only; at-rules would leak unscoped inner selectors.
    for (const scope of [scopeStyleToHost, scopeDocumentStyleToHost]) {
      expect(() => scope('@media (min-width: 1px) { .a { color: red; } }', PREFIX)).toThrow(
        'at-rules cannot be scoped'
      )
      expect(() => scope('.a { color: red;', PREFIX)).toThrow('never closes')
      expect(() => scope('{ color: red; }', PREFIX)).toThrow('no selector')
    }
  })
})
