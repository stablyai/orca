import { describe, expect, it } from 'vitest'

import { escapeEmbeddedHtmlCopy } from './embedded-webview-copy'

// The WebView-injection call sites are not localized yet, so this covers the
// primitive on its own. Extraction adds the cases that assert translated copy
// reaches the rich-editor and terminal documents already escaped.
describe('escapeEmbeddedHtmlCopy', () => {
  it('escapes text and attribute delimiters', () => {
    expect(escapeEmbeddedHtmlCopy('<Copy "all" & more>')).toBe(
      '&lt;Copy &quot;all&quot; &amp; more&gt;'
    )
  })

  it('neutralizes markup that would otherwise parse as an element', () => {
    expect(escapeEmbeddedHtmlCopy('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;'
    )
    expect(escapeEmbeddedHtmlCopy('<b>Task & more</b>')).toBe('&lt;b&gt;Task &amp; more&lt;/b&gt;')
  })

  it('escapes ampersands first so entities are not double-decoded', () => {
    expect(escapeEmbeddedHtmlCopy('&lt;')).toBe('&amp;lt;')
  })

  it('escapes the single quote that would close an attribute', () => {
    expect(escapeEmbeddedHtmlCopy("it's")).toBe('it&#39;s')
  })

  it('leaves copy without markup untouched', () => {
    expect(escapeEmbeddedHtmlCopy('Seleccionar todo')).toBe('Seleccionar todo')
    expect(escapeEmbeddedHtmlCopy('')).toBe('')
  })
})
