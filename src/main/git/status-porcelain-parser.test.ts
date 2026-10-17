import { describe, expect, it, vi } from 'vitest'
import { StatusPorcelainParser } from '../../shared/git-status-porcelain-parser'

describe('StatusPorcelainParser', () => {
  it('parses branch headers and changed/untracked/ignored records', () => {
    const parser = new StatusPorcelainParser()
    const stopped = parser.update(
      '# branch.oid abc123\n' +
        '# branch.head feature/x\n' +
        '# branch.upstream origin/feature/x\n' +
        '# branch.ab +2 -1\n' +
        '1 M. N... 100644 100644 100644 aaaa aaaa src/staged.ts\n' +
        '1 .M N... 100644 100644 100644 bbbb bbbb src/unstaged.ts\n' +
        '? new.txt\n' +
        '! dist/\n',
      0
    )
    parser.finish()

    expect(stopped).toBe(false)
    expect(parser.branch.head).toBe('abc123')
    expect(parser.branch.branch).toBe('refs/heads/feature/x')
    expect(parser.branch.upstreamName).toBe('origin/feature/x')
    expect(parser.branch.upstreamAheadBehind).toEqual({ ahead: 2, behind: 1 })
    expect(parser.entries).toEqual([
      { path: 'src/staged.ts', status: 'modified', area: 'staged' },
      { path: 'src/unstaged.ts', status: 'modified', area: 'unstaged' },
      { path: 'new.txt', status: 'untracked', area: 'untracked' }
    ])
    expect(parser.ignoredPaths).toEqual(['dist/'])
    expect(parser.statusLength).toBe(3)
  })

  it('parses type-2 rename records with old path after the tab', () => {
    const parser = new StatusPorcelainParser()
    parser.update('2 R. N... 100644 100644 100644 aaaa bbbb R100 new.ts\told.ts\n', 0)
    parser.finish()
    expect(parser.entries).toEqual([
      { path: 'new.ts', status: 'renamed', area: 'staged', oldPath: 'old.ts' }
    ])
  })

  it.each([
    ['src/a file  with spaces.ts ', 'old/a file  with spaces.ts '],
    [' src/leading.ts', ' old/leading.ts'],
    ['"src/tab\\tquote\\\".ts"', '"old/line\\nname.ts"'],
    ['"src/\\303\\251.ts"', '"old/\\342\\230\\203.ts"'],
    ['src/é.ts', 'old/e\u0301.ts']
  ])('preserves path fields across every stream split: %s', (rawPath, rawOldPath) => {
    const line = `2 RM S.MU 100644 100644 100644 aaaa bbbb R100 ${rawPath}\t${rawOldPath}\r\n`
    const complete = new StatusPorcelainParser()
    complete.update(line, 0)
    complete.finish()
    for (let split = 0; split <= line.length; split += 1) {
      const parser = new StatusPorcelainParser()
      parser.update(line.slice(0, split), 0)
      parser.update(line.slice(split), 0)
      parser.finish()
      expect(parser.entries).toEqual(complete.entries)
      expect(parser.statusRecords).toEqual(complete.statusRecords)
      expect(parser.statusLength).toBe(2)
    }
  })

  it('keeps ordinary path spaces and quoted control characters intact', () => {
    const parser = new StatusPorcelainParser()
    parser.update(
      '1 MM N... 100644 100644 100644 aaaa bbbb  src/a  file.ts \n' +
        '1 .M N... 100644 100644 100644 aaaa bbbb "src/a\\tline\\nfile.ts"\n',
      0
    )
    parser.finish()
    expect(parser.entries).toEqual([
      { path: ' src/a  file.ts ', status: 'modified', area: 'staged' },
      { path: ' src/a  file.ts ', status: 'modified', area: 'unstaged' },
      { path: 'src/a\tline\nfile.ts', status: 'modified', area: 'unstaged' }
    ])
  })

  it.each([
    ['1 M. N... 100644', 'modified', undefined],
    ['2 R. N... 100644', 'renamed', ''],
    ['2 R. N... 100644 100644 100644 aaaa bbbb R100\told path', 'renamed', 'old path'],
    ['2 R. N... 100644 100644 100644 aaaa bbbb R100 new path', 'renamed', '']
  ] as const)('keeps truncated record behavior for %s', (line, status, oldPath) => {
    const parser = new StatusPorcelainParser()
    parser.update(`${line}\n`, 0)
    parser.finish()
    expect(parser.entries).toEqual([
      {
        path: line.endsWith('new path') ? 'new path' : '',
        status,
        area: 'staged',
        ...(oldPath === undefined ? {} : { oldPath })
      }
    ])
  })

  it.each(['1 M.', '2 R.'])('bounds temporary fields for space-heavy %s paths', (prefix) => {
    const filePath = `dir/${'space '.repeat(500)}file.ts`
    const rename = prefix.startsWith('2 ')
    const line = `${prefix} N... 100644 100644 100644 aaaa bbbb ${rename ? 'R100 ' : ''}${filePath}${rename ? `\told/${filePath}` : ''}\n`
    const split = vi.spyOn(String.prototype, 'split')
    const parser = new StatusPorcelainParser()
    let largestFieldCount = 0
    try {
      parser.update(line, 0)
      parser.finish()
      for (const result of split.mock.results) {
        if (result.type === 'return' && Array.isArray(result.value)) {
          largestFieldCount = Math.max(largestFieldCount, result.value.length)
        }
      }
    } finally {
      split.mockRestore()
    }
    expect(parser.entries[0]?.path).toBe(filePath)
    expect(parser.entries[0]?.oldPath).toBe(rename ? `old/${filePath}` : undefined)
    expect(largestFieldCount).toBeLessThanOrEqual(9)
  })

  it('marks staged S... submodule rows as commit-changed gitlinks', () => {
    const parser = new StatusPorcelainParser()
    parser.update(
      '1 M. S... 160000 160000 160000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb flutter_mine\n',
      0
    )
    parser.finish()

    expect(parser.entries).toEqual([
      {
        path: 'flutter_mine',
        status: 'modified',
        area: 'staged',
        submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false }
      }
    ])
  })

  it('collects unmerged lines for async resolution rather than parsing inline', () => {
    const parser = new StatusPorcelainParser()
    parser.update('u UU N... 100644 100644 100644 100644 aa bb cc both.ts\n', 0)
    parser.finish()
    expect(parser.entries).toEqual([])
    expect(parser.unmergedLines).toHaveLength(1)
    expect(parser.statusLength).toBe(1)
  })

  it('carries a partial trailing line across chunk boundaries', () => {
    const parser = new StatusPorcelainParser()
    // Split a single record across two chunks.
    parser.update('? partial', 0)
    parser.update('-name.txt\n', 0)
    parser.finish()
    expect(parser.entries).toEqual([
      { path: 'partial-name.txt', status: 'untracked', area: 'untracked' }
    ])
  })

  it('strips trailing CR so CRLF output parses cleanly', () => {
    const parser = new StatusPorcelainParser()
    parser.update('? win.txt\r\n', 0)
    parser.finish()
    expect(parser.entries).toEqual([{ path: 'win.txt', status: 'untracked', area: 'untracked' }])
  })

  it('signals stop once the entry count exceeds the limit', () => {
    const parser = new StatusPorcelainParser()
    const lines = `${Array.from({ length: 5 }, (_, i) => `? f${i}.txt`).join('\n')}\n`
    const stopped = parser.update(lines, 3)
    expect(stopped).toBe(true)
    // The fourth entry (index 3) is what pushed count past the limit of 3.
    expect(parser.entries.length).toBe(4)
    expect(parser.statusLength).toBe(4)
  })

  it('counts unmerged records toward the stop limit', () => {
    const parser = new StatusPorcelainParser()
    const line = 'u UU N... 100644 100644 100644 100644 aa bb cc conflicted.ts\n'
    const stopped = parser.update(line.repeat(4), 3)

    expect(stopped).toBe(true)
    expect(parser.unmergedLines).toHaveLength(4)
    expect(parser.statusLength).toBe(4)
  })

  it('preserves deferred conflicts in status output order', () => {
    const parser = new StatusPorcelainParser()
    parser.update(
      '? before.ts\n' +
        'u UU N... 100644 100644 100644 100644 aa bb cc conflict.ts\n' +
        '? after.ts\n',
      0
    )

    expect(parser.statusRecords).toEqual([
      {
        type: 'entry',
        entry: { path: 'before.ts', status: 'untracked', area: 'untracked' }
      },
      {
        type: 'unmerged',
        line: 'u UU N... 100644 100644 100644 100644 aa bb cc conflict.ts'
      },
      {
        type: 'entry',
        entry: { path: 'after.ts', status: 'untracked', area: 'untracked' }
      }
    ])
  })

  it('does not signal stop when limit is 0 (disabled)', () => {
    const parser = new StatusPorcelainParser()
    const lines = `${Array.from({ length: 50 }, (_, i) => `? f${i}.txt`).join('\n')}\n`
    const stopped = parser.update(lines, 0)
    expect(stopped).toBe(false)
    expect(parser.entries.length).toBe(50)
  })
})
