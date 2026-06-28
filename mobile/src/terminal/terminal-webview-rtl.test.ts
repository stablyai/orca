import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { XTERM_HTML } from './terminal-webview-html'

const htmlSource = readFileSync(new URL('./terminal-webview-html.ts', import.meta.url), 'utf8')

describe('TerminalWebView RTL rows', () => {
  it('BUG-R1 uses the DOM renderer so row-level bidi CSS can affect mobile xterm output', () => {
    const guard = htmlSource.indexOf('if (!FORCE_DOM_RENDERER_FOR_RTL && window.WebglAddon')
    const addon = htmlSource.indexOf('new window.WebglAddon.WebglAddon()')

    expect(htmlSource).toContain('var FORCE_DOM_RENDERER_FOR_RTL = true')
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(addon).toBeGreaterThan(guard)
  })

  it('BUG-R2 adds plaintext bidi handling and inline spans for rows that contain RTL text', () => {
    expect(XTERM_HTML).toContain('unicode-bidi: plaintext')
    expect(XTERM_HTML).toContain('data-orca-rtl-row="true"] > span')
    expect(htmlSource).toContain('var RTL_TEXT_PATTERN = /[\\u0590-\\u08ff\\ufb1d-\\ufefc]/')
    expect(XTERM_HTML).toContain("row.setAttribute('data-orca-rtl-row', 'true')")
    expect(XTERM_HTML).toContain("row.removeAttribute('data-orca-rtl-row')")
  })

  it('BUG-R3 refreshes RTL row markers after the terminal changes visible rows', () => {
    expect(XTERM_HTML).toContain('function scheduleTerminalRtlRows()')
    expect(XTERM_HTML).toContain('term.write(next, function()')
    expect(XTERM_HTML).toContain('term.onScroll(function()')
    expect(XTERM_HTML).toContain('term.onWriteParsed(function()')
    expect(XTERM_HTML).toContain('scheduleTerminalRtlRows();')
  })
})
