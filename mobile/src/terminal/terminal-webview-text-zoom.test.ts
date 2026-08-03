import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'

const terminalWebViewSource = readFileSync(
  new URL('./TerminalWebView.tsx', import.meta.url),
  'utf8'
)
const terminalHtmlSource = readFileSync(
  new URL('./terminal-webview-html.ts', import.meta.url),
  'utf8'
)
const terminalWebglRecoverySource = readFileSync(
  new URL('./terminal-webview-webgl-recovery-injected.ts', import.meta.url),
  'utf8'
)

function extractStatusDotNormalizer() {
  const declarationStart = terminalHtmlSource.indexOf('  var CLAUDE_STATUS_DOT =')
  const declarationEnd = terminalHtmlSource.indexOf('  var PRIVATE_MODE_SCAN_TAIL_LIMIT')
  const functionStart = terminalHtmlSource.indexOf('  function isStatusDotPresentationSelector')
  const functionEnd = terminalHtmlSource.indexOf('\n\n  function enqueueWrite', functionStart)
  expect(declarationStart).toBeGreaterThanOrEqual(0)
  expect(declarationEnd).toBeGreaterThan(declarationStart)
  expect(functionStart).toBeGreaterThan(declarationEnd)
  expect(functionEnd).toBeGreaterThan(functionStart)
  return `${terminalHtmlSource.slice(declarationStart, declarationEnd)}\n${terminalHtmlSource.slice(functionStart, functionEnd)}`
}

function normalizeStatusDotChunks(chunks: string[]) {
  const context: { chunks: string[]; output?: string } = { chunks }
  new Script(`
${extractStatusDotNormalizer()}
output = chunks.map(function(chunk) { return normalizeStatusDotPresentation(chunk); }).join('');
`).runInNewContext(context)
  return context.output ?? ''
}

function resolveTerminalFontFamily(navigatorValue: {
  userAgent: string
  platform: string
  maxTouchPoints: number
}) {
  // Slice only the font block itself (isIOSWebView + terminalFontFamily), anchored
  // on font-related markers so unrelated edits below it can't break this extraction.
  const functionStart = terminalHtmlSource.indexOf('  function isIOSWebView()')
  const declarationLine = terminalHtmlSource.indexOf('  var terminalFontFamily =', functionStart)
  const declarationEnd = terminalHtmlSource.indexOf('\n', declarationLine)
  expect(functionStart).toBeGreaterThanOrEqual(0)
  expect(declarationLine).toBeGreaterThan(functionStart)
  expect(declarationEnd).toBeGreaterThan(declarationLine)
  const context: { navigator: typeof navigatorValue; output?: string } = {
    navigator: navigatorValue
  }
  new Script(`
${terminalHtmlSource.slice(functionStart, declarationEnd)}
output = terminalFontFamily;
`).runInNewContext(context)
  return context.output ?? ''
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
    expect(terminalHtmlSource).toContain('export const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }')
    expect(webViewProps).toContain('source={XTERM_WEBVIEW_SOURCE}')
    expect(webViewProps).not.toContain('source={{ html: XTERM_HTML }}')
  })

  it('forces the Claude status dot to text presentation before xterm writes', () => {
    expect(terminalHtmlSource).toContain('font-variant-emoji: text')
    expect(terminalHtmlSource).toContain('var CLAUDE_STATUS_DOT = String.fromCharCode(0x23fa)')
    expect(terminalHtmlSource).toContain('TEXT_PRESENTATION_SELECTOR = String.fromCharCode(0xfe0e)')
    expect(terminalHtmlSource).toContain(
      'EMOJI_PRESENTATION_SELECTOR = String.fromCharCode(0xfe0f)'
    )
    expect(terminalHtmlSource).toContain('function normalizeStatusDotPresentation(data)')
    expect(terminalHtmlSource).toContain(
      'data.replace(CLAUDE_STATUS_DOT_PATTERN, CLAUDE_STATUS_DOT + TEXT_PRESENTATION_SELECTOR)'
    )
    expect(terminalHtmlSource).toContain('writeQueue.push(normalizeStatusDotPresentation(data))')
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
    const initStart = terminalHtmlSource.indexOf('function init(')
    const initReplay = terminalHtmlSource.indexOf(
      'var replayData = normalizeInitialData(initialData)'
    )
    const clearStart = terminalHtmlSource.indexOf("} else if (msg.type === 'clear') {")
    const clearEnd = terminalHtmlSource.indexOf("} else if (msg.type === 'measure')", clearStart)
    expect(initStart).toBeGreaterThanOrEqual(0)
    expect(initReplay).toBeGreaterThan(initStart)
    expect(clearStart).toBeGreaterThanOrEqual(0)
    expect(clearEnd).toBeGreaterThan(clearStart)
    expect(terminalHtmlSource.slice(initStart, initReplay)).toContain(
      'statusDotPendingSelector = false'
    )
    expect(terminalHtmlSource.slice(clearStart, clearEnd)).toContain(
      'statusDotPendingSelector = false'
    )
  })

  it('loads Unicode 11 before replaying mobile terminal bytes', () => {
    expect(terminalHtmlSource).toContain('XTERM_ENGINE_JS')
    expect(terminalHtmlSource).toContain('window.Unicode11Addon.Unicode11Addon')
    const open = terminalHtmlSource.indexOf('term.open(surface)')
    const unicode = terminalHtmlSource.indexOf("term.unicode.activeVersion = '11'")
    const replay = terminalHtmlSource.indexOf('enqueueWrite(replayData)')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(unicode).toBeGreaterThan(open)
    expect(replay).toBeGreaterThan(unicode)
  })

  it('uses the bundled WebGL-capable xterm stack and platform-safe font fallbacks', () => {
    expect(terminalHtmlSource).not.toContain('cdn.jsdelivr.net')
    expect(terminalWebglRecoverySource).toContain('window.WebglAddon.WebglAddon')
    expect(terminalHtmlSource).toContain('function isIOSWebView()')
    expect(terminalHtmlSource).toContain('fontFamily: terminalFontFamily')
    expect(terminalHtmlSource).toContain("fontWeight: '300'")
    expect(terminalHtmlSource).toContain("fontWeightBold: '500'")
    expect(terminalWebglRecoverySource).toContain('new window.WebglAddon.WebglAddon()')
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
