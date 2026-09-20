import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENGINE_CSS_PLACEHOLDER,
  ENGINE_JS_PLACEHOLDER,
  TERMINAL_DOCUMENT_FIXTURE_PATH,
  terminalDocumentFixture
} from '../../scripts/build-terminal-document-fixture.mjs'
import { XTERM_ENGINE_CSS } from './terminal-webview-engine-css.generated'
import { XTERM_ENGINE_JS } from './terminal-webview-engine.generated'
import { XTERM_HTML } from './terminal-webview-html'

/**
 * The emitted WebView document, byte for byte, against a committed copy of itself.
 *
 * `terminal-webview-payload-hash.test.ts` pins the same bytes as a digest, which answers whether
 * the document moved. This answers where: the whole document is one assertion, so a slice that
 * gained a character, lost an indent or changed order arrives as a diff of the line rather than as
 * two hexadecimal strings. Both are kept — the digest also covers the generated engine, which this
 * fixture deliberately does not.
 *
 * C7.1 moves the document's hand-written script into modules the web page can import, and a
 * generator rebuilds the document from them. This is the instrument that says the native screen
 * kept the document it had. Regenerate the fixture with
 * `node scripts/build-terminal-document-fixture.mjs` only when the emitted document was meant to
 * change; the diff in that commit is the evidence, and reviewing it is the point.
 *
 * It is also the only standing pin on the document now. `terminal-document-flip.test.ts` compared
 * the modules against the pre-flip script and held exactly while no module changed, so it was the
 * proof of the flip rather than a fence; the first lane that had to change a module retired it.
 * A golden that moves without its diff listed in the commit message is a blocking finding.
 */
const fixture = readFileSync(TERMINAL_DOCUMENT_FIXTURE_PATH, 'utf8')

describe('the terminal WebView document', () => {
  it('is byte for byte the document the fixture holds', () => {
    // Rebuilt through the script's own substitution rather than a second copy of it: a fixture
    // written by a different rule than the one that reads it agrees with itself and with nothing.
    expect(terminalDocumentFixture(XTERM_HTML, XTERM_ENGINE_JS, XTERM_ENGINE_CSS)).toBe(fixture)
  })

  it('holds the generated engine as placeholders, so an xterm bump is not a diff here', () => {
    // Without this the fixture could lose a placeholder — inlining the engine, or dropping the
    // section entirely — and the assertion above would still pass against whatever it became.
    for (const placeholder of [ENGINE_JS_PLACEHOLDER, ENGINE_CSS_PLACEHOLDER]) {
      expect(fixture.split(placeholder)).toHaveLength(2)
    }
    expect(fixture).not.toContain(XTERM_ENGINE_JS)
    expect(fixture).not.toContain(XTERM_ENGINE_CSS)
  })

  it('is the whole document once the engine is put back', () => {
    // The placeholder round trip, which is what makes the first case a claim about the document
    // and not only about the hand-written part of it.
    const restored = fixture
      .replace(ENGINE_JS_PLACEHOLDER, () => XTERM_ENGINE_JS)
      .replace(ENGINE_CSS_PLACEHOLDER, () => XTERM_ENGINE_CSS)
    expect(restored).toBe(XTERM_HTML)
  })
})
