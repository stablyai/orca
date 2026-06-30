import { describe, expect, it } from 'vitest'
import {
  TERMINAL_HTTP_URL_MAX_LENGTH,
  TERMINAL_HTTP_URL_REGEX_SOURCE,
  findUrlAtColumn
} from './terminal-webview-url-tap'
import { XTERM_HTML } from './terminal-webview-html'

describe('findUrlAtColumn', () => {
  it('returns the URL when the tapped column falls inside it', () => {
    const line = 'see https://example.com/path for details'
    const start = line.indexOf('https')

    expect(findUrlAtColumn(line, start)).toBe('https://example.com/path')
    expect(findUrlAtColumn(line, start + 5)).toBe('https://example.com/path')
    expect(findUrlAtColumn(line, line.indexOf(' for') - 1)).toBe('https://example.com/path')
  })

  it('returns null when the tap lands on surrounding text or whitespace', () => {
    const line = 'see https://example.com/path for details'

    expect(findUrlAtColumn(line, 0)).toBeNull()
    expect(findUrlAtColumn(line, line.indexOf('https') - 1)).toBeNull()
    expect(findUrlAtColumn(line, line.indexOf('for'))).toBeNull()
  })

  it('resolves the correct URL when several appear on one line', () => {
    const line = 'http://a.test/one  https://b.test/two'

    expect(findUrlAtColumn(line, line.indexOf('a.test'))).toBe('http://a.test/one')
    expect(findUrlAtColumn(line, line.indexOf('b.test'))).toBe('https://b.test/two')
    expect(findUrlAtColumn(line, line.indexOf('  '))).toBeNull()
  })

  it('excludes trailing punctuation from the matched URL', () => {
    const line = 'visit https://example.com.'

    expect(findUrlAtColumn(line, line.indexOf('example'))).toBe('https://example.com')
    expect(findUrlAtColumn(line, line.length - 1)).toBeNull()
  })

  it('only matches http(s) schemes', () => {
    const line = 'ftp://example.com/file and file:///etc/hosts'

    expect(findUrlAtColumn(line, line.indexOf('example'))).toBeNull()
    expect(findUrlAtColumn(line, line.indexOf('etc'))).toBeNull()
  })

  it('matches desktop URL boundary and length guards', () => {
    expect(findUrlAtColumn('prefixhttps://example.com/path', 'prefix'.length)).toBeNull()
    expect(findUrlAtColumn('prefix https://example.com/path', 'prefix '.length)).toBe(
      'https://example.com/path'
    )

    const overlongUrl = `https://example.com/${'a'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH)}`
    expect(findUrlAtColumn(overlongUrl, 0)).toBeNull()
  })

  it('injects URL and OSC tap handling into the WebView document', () => {
    expect(XTERM_HTML).toContain('function findUrlAtColumn(')
    expect(XTERM_HTML).toContain('function urlAtViewportPoint(')
    expect(XTERM_HTML).toContain(JSON.stringify(TERMINAL_HTTP_URL_REGEX_SOURCE))
    expect(XTERM_HTML).toContain('function oscLinkAtViewportPoint(')
    expect(XTERM_HTML).toContain('function notifyTerminalSurfaceTap(')
    expect(XTERM_HTML).toContain("notify({ type: 'open-url', url: tappedUrl });")
  })
})
