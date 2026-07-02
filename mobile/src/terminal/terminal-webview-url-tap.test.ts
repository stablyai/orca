import { describe, expect, it } from 'vitest'
import {
  TERMINAL_HTTP_URL_MAX_LENGTH,
  TERMINAL_HTTP_URL_REGEX_SOURCE,
  findFileUrlAtColumn,
  findUrlAtColumn,
  resolveTerminalOscFileTap,
  resolveTerminalFileUrlTap
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

  it('finds file URLs separately so taps route to file opens', () => {
    const line = 'open file:///tmp/result.json#L12C3 please'

    expect(findFileUrlAtColumn(line, line.indexOf('result'))).toBe('file:///tmp/result.json#L12C3')
    expect(findFileUrlAtColumn(line, 0)).toBeNull()
  })

  it('matches desktop URL boundary and length guards', () => {
    expect(findUrlAtColumn('prefixhttps://example.com/path', 'prefix'.length)).toBeNull()
    expect(findUrlAtColumn('prefix https://example.com/path', 'prefix '.length)).toBe(
      'https://example.com/path'
    )

    const overlongUrl = `https://example.com/${'a'.repeat(TERMINAL_HTTP_URL_MAX_LENGTH)}`
    expect(findUrlAtColumn(overlongUrl, 0)).toBeNull()
  })

  it('resolves file OSC targets to terminal file taps', () => {
    expect(resolveTerminalFileUrlTap('file:///tmp/result.json')).toEqual({
      pathText: '/tmp/result.json',
      line: null,
      column: null
    })
    expect(resolveTerminalFileUrlTap('file:///tmp/result.json#L12C3')).toEqual({
      pathText: '/tmp/result.json',
      line: 12,
      column: 3
    })
    expect(resolveTerminalFileUrlTap('file:///tmp/result.json:8:2')).toEqual({
      pathText: '/tmp/result.json',
      line: 8,
      column: 2
    })
    expect(resolveTerminalFileUrlTap('file:///tmp/report%3A8%3A2')).toEqual({
      pathText: '/tmp/report:8:2',
      line: null,
      column: null
    })
    expect(resolveTerminalFileUrlTap('file:///C:/repo/src/app.ts#L4')).toEqual({
      pathText: 'C:/repo/src/app.ts',
      line: 4,
      column: null
    })
    expect(resolveTerminalFileUrlTap('https://example.com/result.json')).toBeNull()
  })

  it('preserves host-qualified POSIX file OSC targets as terminal paths', () => {
    expect(resolveTerminalFileUrlTap('file://remote-host/tmp/result.json#L12')).toEqual({
      pathText: '//remote-host/tmp/result.json',
      line: 12,
      column: null
    })
  })

  it('treats bracketed IPv6 loopback file OSC targets as local paths', () => {
    expect(resolveTerminalFileUrlTap('file://[::1]/tmp/result.json#L12')).toEqual({
      pathText: '/tmp/result.json',
      line: 12,
      column: null
    })
  })

  it('treats IPv4 loopback file OSC targets as local paths', () => {
    expect(resolveTerminalFileUrlTap('file://127.0.0.1/tmp/result.json#L12')).toEqual({
      pathText: '/tmp/result.json',
      line: 12,
      column: null
    })
  })

  it('preserves UNC authority in file OSC targets', () => {
    expect(resolveTerminalFileUrlTap('file://server/share/repo/app.ts#L12')).toEqual({
      pathText: '//server/share/repo/app.ts',
      line: 12,
      column: null
    })
  })

  it('resolves raw path-like OSC targets to terminal file taps', () => {
    expect(resolveTerminalOscFileTap('docs/README.md')).toEqual({
      pathText: 'docs/README.md',
      line: null,
      column: null
    })
    expect(resolveTerminalOscFileTap('~/notes.md:4:2')).toEqual({
      pathText: '~/notes.md',
      line: 4,
      column: 2
    })
    expect(resolveTerminalOscFileTap('mailto:team@example.com')).toBeNull()
  })

  it('injects URL and OSC tap handling into the WebView document', () => {
    expect(XTERM_HTML).toContain('function findUrlAtColumn(')
    expect(XTERM_HTML).toContain('function findFileUrlAtColumn(')
    expect(XTERM_HTML).toContain('function fileUrlAtViewportPoint(')
    expect(XTERM_HTML).toContain('function urlAtViewportPoint(')
    expect(XTERM_HTML).toContain(JSON.stringify(TERMINAL_HTTP_URL_REGEX_SOURCE))
    expect(XTERM_HTML).toContain('function oscLinkAtViewportPoint(')
    expect(XTERM_HTML).toContain('function resolveTerminalOscFileTap(')
    expect(XTERM_HTML).toContain('function resolveTerminalFileUrlTap(')
    expect(XTERM_HTML).toContain('function isLocalFileUriHostname(')
    expect(XTERM_HTML).toContain('return parsePathLineCol(value);')
    expect(XTERM_HTML).toContain('function notifyTerminalSurfaceTap(')
    expect(XTERM_HTML).toContain("notify({ type: 'open-url', url: tappedUrl });")
  })
})
