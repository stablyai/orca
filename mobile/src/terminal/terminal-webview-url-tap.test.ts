import { describe, expect, it } from 'vitest'
import type { TappedFilePath } from './terminal-path-tap'
import {
  resolveTerminalFileUrlTap as documentResolveTerminalFileUrlTap,
  resolveTerminalOscFileTap as documentResolveTerminalOscFileTap
} from './document/osc-link-tap'
import {
  TERMINAL_HTTP_URL_MAX_LENGTH,
  findFileUrlAtColumn,
  findUrlAtColumn,
  resolveTerminalOscFileTap,
  resolveTerminalFileUrlTap
} from './terminal-webview-url-tap'

type FileTapResolverCase = {
  name: string
  uri: string
  expected: TappedFilePath | null
}

const FILE_URL_TAP_CASES: FileTapResolverCase[] = [
  {
    name: 'plain file URL',
    uri: 'file:///tmp/result.json',
    expected: { pathText: '/tmp/result.json', line: null, column: null }
  },
  {
    name: 'hash line and column',
    uri: 'file:///tmp/result.json#L12C3',
    expected: { pathText: '/tmp/result.json', line: 12, column: 3 }
  },
  {
    name: 'trailing line and column suffix',
    uri: 'file:///tmp/result.json:8:2',
    expected: { pathText: '/tmp/result.json', line: 8, column: 2 }
  },
  {
    name: 'percent-encoded colon suffix stays in the path',
    uri: 'file:///tmp/report%3A8%3A2',
    expected: { pathText: '/tmp/report:8:2', line: null, column: null }
  },
  {
    name: 'Windows drive path with hash line',
    uri: 'file:///C:/repo/src/app.ts#L4',
    expected: { pathText: 'C:/repo/src/app.ts', line: 4, column: null }
  },
  {
    name: 'host-qualified POSIX authority is preserved',
    uri: 'file://remote-host/tmp/result.json#L12',
    expected: { pathText: '//remote-host/tmp/result.json', line: 12, column: null }
  },
  {
    name: 'bracketed IPv6 loopback is local',
    uri: 'file://[::1]/tmp/result.json#L12',
    expected: { pathText: '/tmp/result.json', line: 12, column: null }
  },
  {
    name: 'IPv4 loopback is local',
    uri: 'file://127.0.0.1/tmp/result.json#L12',
    expected: { pathText: '/tmp/result.json', line: 12, column: null }
  },
  {
    name: 'UNC authority is preserved',
    uri: 'file://server/share/repo/app.ts#L12',
    expected: { pathText: '//server/share/repo/app.ts', line: 12, column: null }
  },
  {
    name: 'non-file scheme is rejected',
    uri: 'https://example.com/result.json',
    expected: null
  }
]

const OSC_FILE_TAP_CASES: FileTapResolverCase[] = [
  {
    name: 'relative path',
    uri: 'docs/README.md',
    expected: { pathText: 'docs/README.md', line: null, column: null }
  },
  {
    name: 'tilde path with line and column',
    uri: '~/notes.md:4:2',
    expected: { pathText: '~/notes.md', line: 4, column: 2 }
  },
  {
    name: 'mailto target is rejected',
    uri: 'mailto:team@example.com',
    expected: null
  }
]

type InjectedFileTapResolver = (uri: string) => TappedFilePath | null

// Why: the document carries its own copy of this logic, so the two are run against one set of
// cases and cannot drift. Both are modules now, so the comparison is an import rather than an
// evaluation of the document's text.
function createInjectedFileTapResolvers(): {
  resolveTerminalFileUrlTap: InjectedFileTapResolver
  resolveTerminalOscFileTap: InjectedFileTapResolver
} {
  return {
    resolveTerminalFileUrlTap: documentResolveTerminalFileUrlTap,
    resolveTerminalOscFileTap: documentResolveTerminalOscFileTap
  }
}

describe.each([
  ['module', { resolveTerminalFileUrlTap, resolveTerminalOscFileTap }],
  ['injected', createInjectedFileTapResolvers()]
] as const)('terminal file tap resolvers (%s)', (_variant, resolvers) => {
  it.each(FILE_URL_TAP_CASES)('resolves file URL: $name', ({ uri, expected }) => {
    expect(resolvers.resolveTerminalFileUrlTap(uri)).toEqual(expected)
  })

  it.each(OSC_FILE_TAP_CASES)('resolves OSC target: $name', ({ uri, expected }) => {
    expect(resolvers.resolveTerminalOscFileTap(uri)).toEqual(expected)
  })

  it.each(FILE_URL_TAP_CASES)('OSC resolver accepts file URL: $name', ({ uri, expected }) => {
    if (expected === null) {
      return
    }
    expect(resolvers.resolveTerminalOscFileTap(uri)).toEqual(expected)
  })
})

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
})
