import { describe, expect, it } from 'vitest'
import { scopeDocumentStyleToHost, scopeStyleToHost } from './document-style-scoping'

const PREFIX = '.host'

describe('a stylesheet held under a host element', () => {
  it('refuses at-rules through either export before inner selectors can leak', () => {
    // Textual rewriting supports flat sheets only; at-rules would leak unscoped inner selectors.
    for (const scope of [scopeStyleToHost, scopeDocumentStyleToHost]) {
      expect(() => scope('@media (min-width: 1px) { .a { color: red; } }', PREFIX)).toThrow(
        'at-rules cannot be scoped'
      )
    }
  })
})
