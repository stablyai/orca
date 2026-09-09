import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildMobileRichMarkdownEditorHtml } from './mobile-rich-markdown-editor-html'

// The snapshot is main's document, captured before the body/script split. Splitting the
// constants must not move a single byte of what the WebView loads.
describe('mobile rich markdown editor document', () => {
  it('reproduces the pre-split document byte for byte', () => {
    const expected = readFileSync(
      new URL('./mobile-rich-markdown-editor-document.main-snapshot.html', import.meta.url),
      'utf8'
    )
    expect(buildMobileRichMarkdownEditorHtml()).toBe(expected)
  })
})
