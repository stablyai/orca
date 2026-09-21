import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

// Why: every other WebView test exercises one slice of the document, so an edit to an
// uncovered region ships silently. A diff here means the emitted WebView source changed —
// update these values only when that change is deliberate, and only after checking the
// document still runs. Refactors that merely move slice boundaries must leave them alone.
const EXPECTED_SHA256 = '0be398e4d7131b391fd8e4ec7661f9cb3153af1a80c7f4f7435116372bf24700'
const EXPECTED_LENGTH = 729363

describe('terminal WebView payload', () => {
  it('composes the expected document', () => {
    expect(XTERM_HTML.length).toBe(EXPECTED_LENGTH)
    expect(createHash('sha256').update(XTERM_HTML, 'utf8').digest('hex')).toBe(EXPECTED_SHA256)
  })
})
