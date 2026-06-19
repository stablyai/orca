import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./TerminalWebView.tsx', import.meta.url), 'utf8')

describe('TerminalWebView text zoom', () => {
  it('pins textZoom to 100 so Android system font scale cannot inflate glyphs past xterm cell metrics', () => {
    const start = source.indexOf('<WebView')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('/>', start)
    expect(end).toBeGreaterThan(start)
    const webViewProps = source.slice(start, end)
    expect(webViewProps).toContain('textZoom={100}')
  })

  it('keeps the HTML source object stable so parent renders do not reload xterm', () => {
    const start = source.indexOf('<WebView')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = source.indexOf('/>', start)
    expect(end).toBeGreaterThan(start)
    const webViewProps = source.slice(start, end)
    expect(source).toContain('const XTERM_WEBVIEW_SOURCE = { html: XTERM_HTML }')
    expect(webViewProps).toContain('source={XTERM_WEBVIEW_SOURCE}')
    expect(webViewProps).not.toContain('source={{ html: XTERM_HTML }}')
  })
})
