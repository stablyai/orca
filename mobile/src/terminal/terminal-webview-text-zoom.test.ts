import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  documentScopePreamble,
  generatedDocumentModule
} from './document/generated-document-region.test-support'
import { XTERM_HTML } from './terminal-webview-html'

const terminalWebViewSource = readFileSync(
  new URL('./TerminalWebView.tsx', import.meta.url),
  'utf8'
)
const terminalHtmlModuleSource = readFileSync(
  new URL('./terminal-webview-html.ts', import.meta.url),
  'utf8'
)
const terminalHtmlDocumentShellSource = readFileSync(
  new URL('./terminal-webview-html/document-shell.ts', import.meta.url),
  'utf8'
)
// Read behavior from the assembled document: it is what the WebView runs, and the module source
// alone cannot prove the generated script carries the code.
const terminalHtmlSource = XTERM_HTML

const terminalWebglRecoverySource = await generatedDocumentModule('webgl-recovery')

function extractStatusDotNormalizer() {
  // Ruling 21 put the dot constants in the scope factory, which the preamble already carries, so
  // what is sliced here is the normalizer itself and nothing else.
  const declarationAt = terminalHtmlSource.indexOf('  const statusDot = String.fromCharCode(9210);')
  const functionStart = terminalHtmlSource.indexOf('  function isStatusDotPresentationSelector')
  const functionEnd = terminalHtmlSource.indexOf('\n  function enqueueWrite', functionStart)
  expect(declarationAt).toBeGreaterThanOrEqual(0)
  expect(functionStart).toBeGreaterThan(declarationAt)
  expect(functionEnd).toBeGreaterThan(functionStart)
  return `${documentScopePreamble()}${terminalHtmlSource.slice(functionStart, functionEnd)}`
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
  // Ruling 20 put the assignment inside `startTextScaling`, whose earlier statements read
  // elements and constants this has nothing to do with. So the declarations come from one slice
  // and the font line from another, which is what "only the font block itself" already meant.
  const declarationsEnd = terminalHtmlSource.indexOf('  function startTextScaling()', functionStart)
  const declarationLine = terminalHtmlSource.indexOf(
    '    scope.terminalFontFamily =',
    declarationsEnd
  )
  const declarationEnd = terminalHtmlSource.indexOf(';\n', declarationLine) + 1
  expect(functionStart).toBeGreaterThanOrEqual(0)
  expect(declarationsEnd).toBeGreaterThan(functionStart)
  expect(declarationLine).toBeGreaterThan(declarationsEnd)
  expect(declarationEnd).toBeGreaterThan(declarationLine)
  const context: { navigator: typeof navigatorValue; output?: string } = {
    navigator: navigatorValue
  }
  new Script(`
${documentScopePreamble()}${terminalHtmlSource.slice(functionStart, declarationsEnd)}
${terminalHtmlSource.slice(declarationLine, declarationEnd)}
output = scope.terminalFontFamily;
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
    expect(terminalHtmlModuleSource).toContain(
      'export const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }'
    )
    expect(webViewProps).toContain('source={XTERM_WEBVIEW_SOURCE}')
    expect(webViewProps).not.toContain('source={{ html: XTERM_HTML }}')
  })

  it('forces the Claude status dot to text presentation before xterm writes', () => {
    expect(terminalHtmlSource).toContain('font-variant-emoji: text')
    // Ruling 21: the dot's value is in the scope factory, not in a parse-time write.
    expect(terminalHtmlSource).toContain('const statusDot = String.fromCharCode(9210);')
    expect(terminalHtmlSource).toContain(
      'const textPresentationSelector = String.fromCharCode(65038);'
    )
    expect(terminalHtmlSource).toContain(
      'const emojiPresentationSelector = String.fromCharCode(65039);'
    )
    expect(terminalHtmlSource).toContain('function normalizeStatusDotPresentation(data)')
    expect(terminalHtmlSource).toContain(
      'data.replace(\n      scope.CLAUDE_STATUS_DOT_PATTERN,\n      scope.CLAUDE_STATUS_DOT + scope.TEXT_PRESENTATION_SELECTOR\n    )'
    )
    expect(terminalHtmlSource).toContain(
      'scope.writeQueue.push(normalizeStatusDotPresentation(data))'
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
    const initStart = terminalHtmlSource.indexOf('function init(')
    const initReplay = terminalHtmlSource.indexOf(
      'const replayData = normalizeInitialData(initialData)'
    )
    const clearStart = terminalHtmlSource.indexOf('} else if (msg.type === "clear") {')
    const clearEnd = terminalHtmlSource.indexOf('} else if (msg.type === "measure")', clearStart)
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
    const open = terminalHtmlSource.indexOf('scope.term.open(scope.surface)')
    const unicode = terminalHtmlSource.indexOf('scope.term.unicode.activeVersion = "11"')
    const replay = terminalHtmlSource.indexOf('enqueueWrite(scope.ESC + "[0m" + replayData)')
    expect(open).toBeGreaterThanOrEqual(0)
    expect(unicode).toBeGreaterThan(open)
    expect(replay).toBeGreaterThan(unicode)
  })

  it('uses the bundled WebGL-capable xterm stack and platform-safe font fallbacks', () => {
    expect(terminalHtmlSource).not.toContain('cdn.jsdelivr.net')
    // C7.5 moved the engine constructors onto the scope so the page can set them; inside the
    // document the default still reads the bundled engine, and it is now the preamble that
    // carries the read rather than the recovery module.
    expect(documentScopePreamble()).toContain('window.WebglAddon.WebglAddon')
    expect(terminalWebglRecoverySource).toContain('scope.createWebglAddon()')
    expect(terminalHtmlSource).toContain('function isIOSWebView()')
    expect(terminalHtmlSource).toContain('fontFamily: scope.terminalFontFamily')
    expect(terminalHtmlSource).toContain('fontWeight: "300"')
    expect(terminalHtmlSource).toContain('fontWeightBold: "500"')
    expect(documentScopePreamble()).toContain('new window.WebglAddon.WebglAddon()')
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
