// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTerminalDocumentScope } from './document/document-scope'
import { normalizeStatusDotPresentation } from './document/write-queue'
import { startTextScaling } from './document/text-scaling'
import {
  documentModuleSource,
  webviewPageSource
} from './document/document-module-source.test-support'

const terminalWebViewSource = readFileSync(join(import.meta.dirname, 'TerminalWebView.tsx'), 'utf8')
const terminalHtmlModuleSource = readFileSync(
  join(import.meta.dirname, 'terminal-webview-html.ts'),
  'utf8'
)
const terminalHtmlDocumentShellSource = readFileSync(
  join(import.meta.dirname, 'terminal-webview-html', 'document-shell.ts'),
  'utf8'
)
// The document's own source, which is what the WebView runs once bundled.
const terminalHtmlSource = webviewPageSource()

const terminalWebglRecoverySource = documentModuleSource('webgl-recovery')

function normalizeStatusDotChunks(chunks: string[]) {
  const scope = createTerminalDocumentScope()
  return chunks.map((chunk) => normalizeStatusDotPresentation(scope, chunk)).join('')
}

/**
 * The font the document picks for this navigator.
 *
 * `startTextScaling` is what assigns it, and it also reads the two scroll elements, so the markup
 * they live in is planted first. The navigator is stubbed rather than injected into an evaluation:
 * the module reads the real one, which is the whole point of the case.
 */
function resolveTerminalFontFamily(navigatorValue: {
  userAgent: string
  platform: string
  maxTouchPoints: number
}) {
  document.body.innerHTML =
    '<div id="scroll-indicator"><div id="scroll-thumb"></div></div>' +
    '<div id="terminal-container"><div id="terminal-surface"></div></div>'
  vi.stubGlobal('navigator', navigatorValue)
  try {
    const scope = createTerminalDocumentScope()
    startTextScaling(scope)
    return scope.terminalFontFamily
  } finally {
    vi.unstubAllGlobals()
  }
}

describe('TerminalWebView text zoom', () => {
  it('pins textZoom to 100 so Android system font scale cannot inflate glyphs past xterm cell metrics', () => {
    const start = terminalWebViewSource.indexOf('<WebView')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = terminalWebViewSource.indexOf('/>', start)
    expect(end).toBeGreaterThan(start)
    const webViewProps = terminalWebViewSource.slice(start, end)
    expect(webViewProps).toContain('textZoom={100}')
  })

  it('keeps the HTML source object stable so parent renders do not reload xterm', () => {
    const start = terminalWebViewSource.indexOf('<WebView')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = terminalWebViewSource.indexOf('/>', start)
    expect(end).toBeGreaterThan(start)
    const webViewProps = terminalWebViewSource.slice(start, end)
    expect(terminalHtmlModuleSource).toContain(
      'export const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }'
    )
    expect(webViewProps).toContain('source={XTERM_WEBVIEW_SOURCE}')
    expect(webViewProps).not.toContain('source={{ html: XTERM_HTML }}')
  })

  it('forces the Claude status dot to text presentation before xterm writes', () => {
    expect(terminalHtmlSource).toContain('font-variant-emoji: text')
    // The dot and its two selectors are the write queue's own constants, and the pattern is a
    // literal because a construction at a module's top level would be parse-time work (ruling 20).
    expect(terminalHtmlSource).toContain("const CLAUDE_STATUS_DOT = '\\u23fa'")
    expect(terminalHtmlSource).toContain("const TEXT_PRESENTATION_SELECTOR = '\\ufe0e'")
    expect(terminalHtmlSource).toContain("const EMOJI_PRESENTATION_SELECTOR = '\\ufe0f'")
    expect(terminalHtmlSource).toContain(
      'const CLAUDE_STATUS_DOT_PATTERN = /\\u23fa[\\ufe0e\\ufe0f]*/g'
    )
    expect(terminalHtmlSource).toContain('export function normalizeStatusDotPresentation(')
    expect(terminalHtmlSource).toContain(
      'CLAUDE_STATUS_DOT_PATTERN,\n    CLAUDE_STATUS_DOT + TEXT_PRESENTATION_SELECTOR'
    )
    expect(terminalHtmlSource).toContain(
      'scope.writeQueue.push(normalizeStatusDotPresentation(scope, data))'
    )
  })

  it('normalizes Claude status dots idempotently across write chunks', () => {
    const dot = String.fromCharCode(0x23fa)
    const textSelector = String.fromCharCode(0xfe0e)
    const emojiSelector = String.fromCharCode(0xfe0f)
    const textDot = dot + textSelector

    expect(normalizeStatusDotChunks([dot])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot + emojiSelector])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot + textSelector])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot + textSelector + emojiSelector])).toBe(textDot)
    expect(normalizeStatusDotChunks([dot, emojiSelector, ' ready'])).toBe(`${textDot} ready`)
    expect(normalizeStatusDotChunks([dot, textSelector, ' ready'])).toBe(`${textDot} ready`)
    expect(normalizeStatusDotChunks([dot, textSelector, emojiSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
    expect(normalizeStatusDotChunks([dot, emojiSelector, textSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
    expect(normalizeStatusDotChunks([dot + textSelector, emojiSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
    expect(normalizeStatusDotChunks([dot + emojiSelector, textSelector, ' ready'])).toBe(
      `${textDot} ready`
    )
  })

  it('resets pending Claude status dot selector state when the terminal lifecycle resets', () => {
    const initStart = terminalHtmlSource.indexOf('export function init(')
    const initReplay = terminalHtmlSource.indexOf(
      'const replayData = normalizeInitialData(initialData)'
    )
    const clearStart = terminalHtmlSource.indexOf("} else if (msg.type === 'clear') {")
    const clearEnd = terminalHtmlSource.indexOf("} else if (msg.type === 'measure')", clearStart)
    expect(initStart).toBeGreaterThanOrEqual(0)
    expect(initReplay).toBeGreaterThan(initStart)
    expect(clearStart).toBeGreaterThanOrEqual(0)
    expect(clearEnd).toBeGreaterThan(clearStart)
    expect(terminalHtmlSource.slice(initStart, initReplay)).toContain(
      'scope.statusDotPendingSelector = false'
    )
    expect(terminalHtmlSource.slice(clearStart, clearEnd)).toContain(
      'scope.statusDotPendingSelector = false'
    )
  })

  it('loads Unicode 11 before replaying mobile terminal bytes', () => {
    expect(terminalHtmlDocumentShellSource).toContain('XTERM_ENGINE_JS')
    expect(terminalHtmlSource).toContain('window.Unicode11Addon.Unicode11Addon')
    const open = terminalHtmlSource.indexOf('scope.term.open(scope.surface!)')
    const unicode = terminalHtmlSource.indexOf("scope.term.unicode.activeVersion = '11'")
    const replay = terminalHtmlSource.indexOf("enqueueWrite(scope, ESC + '[0m' + replayData)")
    expect(open).toBeGreaterThanOrEqual(0)
    expect(unicode).toBeGreaterThan(open)
    expect(replay).toBeGreaterThan(unicode)
  })

  it('uses the bundled WebGL-capable xterm stack and platform-safe font fallbacks', () => {
    expect(terminalHtmlSource).not.toContain('cdn.jsdelivr.net')
    // C7.5 moved the engine constructors onto the scope so the page can set them; inside the
    // document the default still reads the bundled engine, and it is now the preamble that
    // carries the read rather than the recovery module.
    expect(terminalHtmlSource).toContain('window.WebglAddon.WebglAddon')
    expect(terminalWebglRecoverySource).toContain('scope.createWebglAddon()')
    expect(terminalHtmlSource).toContain('export function isIOSWebView(')
    expect(terminalHtmlSource).toContain('fontFamily: scope.terminalFontFamily')
    expect(terminalHtmlSource).toContain("fontWeight: '300'")
    expect(terminalHtmlSource).toContain("fontWeightBold: '500'")
    expect(terminalHtmlSource).toContain('new window.WebglAddon.WebglAddon()')
  })

  const IOS_IPHONE_NAVIGATOR = {
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15',
    platform: 'iPhone',
    maxTouchPoints: 5
  }
  const ANDROID_NAVIGATOR = {
    userAgent: 'Mozilla/5.0 (Linux; Android 16)',
    platform: 'Linux armv8l',
    maxTouchPoints: 5
  }

  it('starts iOS WebViews on ui-monospace, never SF Mono, still ending in a generic monospace guarantee', () => {
    const fontFamily = resolveTerminalFontFamily(IOS_IPHONE_NAVIGATOR)
    expect(fontFamily.startsWith('ui-monospace, "Menlo"')).toBe(true)
    expect(fontFamily.startsWith('"SF Mono"')).toBe(false)
    // The chain must always terminate in the generic so it can never fall back to
    // a script/proportional system face — the actual iOS bug being fixed.
    expect(fontFamily.endsWith(', monospace')).toBe(true)
  })

  it('treats touch iPadOS WebViews that report MacIntel as iOS for font fallback', () => {
    const fontFamily = resolveTerminalFontFamily({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15',
      platform: 'MacIntel',
      maxTouchPoints: 5
    })
    expect(fontFamily.startsWith('ui-monospace, "Menlo"')).toBe(true)
    expect(fontFamily.startsWith('"SF Mono"')).toBe(false)
    expect(fontFamily.endsWith(', monospace')).toBe(true)
  })

  it('keeps the SF Mono lead outside iOS WebViews and shares the identical fallback tail', () => {
    const androidFontFamily = resolveTerminalFontFamily(ANDROID_NAVIGATOR)
    expect(androidFontFamily.startsWith('"SF Mono", "Menlo"')).toBe(true)
    expect(androidFontFamily.endsWith(', monospace')).toBe(true)
    // Only the lead family may differ across platforms; the rest of the chain is
    // shared so the two platforms cannot silently drift apart.
    const iosFontFamily = resolveTerminalFontFamily(IOS_IPHONE_NAVIGATOR)
    const tailFrom = (family: string) => family.slice(family.indexOf('"Menlo"'))
    expect(tailFrom(androidFontFamily)).toBe(tailFrom(iosFontFamily))
  })
})
