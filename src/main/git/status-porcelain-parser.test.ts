import { describe, expect, it } from 'vitest'
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
