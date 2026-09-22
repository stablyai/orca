import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildMobileRichMarkdownEditorHtml } from './mobile-rich-markdown-editor-html'
import { RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT } from './rich-markdown-editor-document-script.generated'

/**
 * Everything of the WebView's page that is not the document itself, pinned byte for byte.
 *
 * The whole-document digest this file used to carry cannot survive C7.10 C1 and does not need to:
 * the script is now an esbuild bundle of `src/components/rich-markdown/` rather than seven string
 * constants a concatenator glued together, so its bytes are the bundler's and the proof that it is
 * the same *document* is `rich-markdown/native-document-bundle.test.ts`, which runs it.
 *
 * What did not move is the page around it — the head, the stylesheet, the markup — and that is
 * still a byte fact worth holding, because a stray character in the CSS is invisible to every
 * behavioural test there is.
 *
 * Two different digests, so which is which:
 *
 * - The one this file used to assert was of main's *whole document*, script included:
 *   `1ef29c8802170800011e8accf1966bc542cdd7dd5c9600bacb6e0860f77b6df8`, 29,852 bytes. It is gone,
 *   and nothing below reproduces it.
 * - `DOCUMENT_SHELL_SHA256` below is of the *page around the script*, the document with its
 *   `<script>` region emptied. It was taken twice — on main's document and on this one — and the
 *   two readings agreed, which is what says the head, the stylesheet and the markup did not move.
 */
const DOCUMENT_SHELL_SHA256 = '5054e1d5c87e4ce1805d4856ddc8bf36804e697675e6013d84da453d3e81af25'
const DOCUMENT_SHELL_BYTES = 5621

const SCRIPT_OPEN = '  <script>\n'
const SCRIPT_CLOSE = '\n  </script>'

/** The document with its script region emptied, which is what the digest above is of. */
function documentShell(html: string): string {
  const open = html.indexOf(SCRIPT_OPEN) + SCRIPT_OPEN.length
  const close = html.indexOf(SCRIPT_CLOSE, open)
  expect(open).toBeGreaterThan(SCRIPT_OPEN.length - 1)
  expect(close).toBeGreaterThan(open)
  return html.slice(0, open) + html.slice(close)
}

describe('mobile rich markdown editor document', () => {
  it('reproduces the page around the document byte for byte', () => {
    const shell = documentShell(buildMobileRichMarkdownEditorHtml())
    expect(Buffer.byteLength(shell, 'utf8')).toBe(DOCUMENT_SHELL_BYTES)
    expect(createHash('sha256').update(shell, 'utf8').digest('hex')).toBe(DOCUMENT_SHELL_SHA256)
  })

  it('carries the bundled document, whole, as its only script', () => {
    const html = buildMobileRichMarkdownEditorHtml()
    expect(html).toContain(`${SCRIPT_OPEN}${RICH_MARKDOWN_EDITOR_DOCUMENT_SCRIPT}${SCRIPT_CLOSE}`)
    // One script, so the digest above is over the whole of what is not the document.
    expect(html.split('<script>')).toHaveLength(2)
    // The precondition for the shell digest: emptying the region actually removes the document.
    expect(documentShell(html)).not.toContain('createRichMarkdownEditorDocument')
  })
})
