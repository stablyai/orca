import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildMobileRichMarkdownEditorHtml } from './mobile-rich-markdown-editor-html'

// Digest of main's document at e80fae0c4d, captured before the body/script split. Splitting the
// constants must not move a single byte of what the WebView loads. A hash rather than a
// checked-in HTML file, because the formatter would rewrite the file and defeat the check.
const PRE_SPLIT_DOCUMENT_SHA256 = '1ef29c8802170800011e8accf1966bc542cdd7dd5c9600bacb6e0860f77b6df8'
const PRE_SPLIT_DOCUMENT_BYTES = 29852

describe('mobile rich markdown editor document', () => {
  it('reproduces the pre-split document byte for byte', () => {
    const document = buildMobileRichMarkdownEditorHtml()
    expect(Buffer.byteLength(document, 'utf8')).toBe(PRE_SPLIT_DOCUMENT_BYTES)
    expect(createHash('sha256').update(document, 'utf8').digest('hex')).toBe(
      PRE_SPLIT_DOCUMENT_SHA256
    )
  })
})
