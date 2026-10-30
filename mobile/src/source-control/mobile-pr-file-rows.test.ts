import { describe, expect, it } from 'vitest'
import type { GitHubPRFile } from '../../../src/shared/github/pull-request-types'
import type { PRComment } from '../../../src/shared/github/comment-types'
import { buildMobilePrFileRows, countMobilePrFileThreads } from './mobile-pr-file-rows'

function file(path: string, viewerViewedState?: GitHubPRFile['viewerViewedState']): GitHubPRFile {
  return {
    path,
    status: 'modified',
    additions: 1,
    deletions: 0,
    isBinary: false,
    viewerViewedState
  }
}

function comment(partial: Partial<PRComment> & { id: number }): PRComment {
  return { author: 'a', authorAvatarUrl: '', body: '', createdAt: '', url: '', ...partial }
}

const FILES = [
  file('mobile/src/ui/Banner.tsx', 'VIEWED'),
  file('mobile/src/ui/ListRow.tsx'),
  file('docs/a.md', 'VIEWED'),
  file('docs/b.md', 'VIEWED'),
  file('README.md', 'DISMISSED')
]

function rows(options: Partial<Parameters<typeof buildMobilePrFileRows>[0]> = {}) {
  return buildMobilePrFileRows({
    files: FILES,
    threadCounts: new Map(),
    filters: new Set(),
    viewMode: 'tree',
    directoryExpansion: new Map(),
    ...options
  }).map((row) =>
    row.kind === 'directory'
      ? `${'  '.repeat(row.depth)}${row.name}/ ${row.viewedCount}/${row.fileCount}${row.collapsed ? ' folded' : ''}`
      : `${'  '.repeat(row.depth)}${row.name}${row.viewed ? ' ✓' : ''}${row.changedSinceViewed ? ' changed' : ''}`
  )
}

describe('buildMobilePrFileRows', () => {
  it('compacts single-child folders and folds folders whose files are all viewed', () => {
    expect(rows()).toEqual([
      'docs/ 2/2 folded',
      'mobile/src/ui/ 1/2',
      '  Banner.tsx ✓',
      '  ListRow.tsx',
      'README.md changed'
    ])
  })

  it("keeps the user's choice over the viewed fold", () => {
    const expansion = new Map([
      ['dir::pr::docs', true],
      ['dir::pr::mobile/src/ui', false]
    ])
    expect(rows({ directoryExpansion: expansion })).toEqual([
      'docs/ 2/2',
      '  a.md ✓',
      '  b.md ✓',
      'mobile/src/ui/ 1/2 folded',
      'README.md changed'
    ])
  })

  it('treats a file changed since viewing as unviewed', () => {
    expect(rows({ filters: new Set(['unviewed']) })).toEqual([
      'mobile/src/ui/ 0/1',
      '  ListRow.tsx',
      'README.md changed'
    ])
  })
})

describe('countMobilePrFileThreads', () => {
  it('counts each thread once and skips outdated or file-level comments', () => {
    const counts = countMobilePrFileThreads([
      comment({ id: 1, path: 'a.ts', line: 3, threadId: 't1' }),
      comment({ id: 2, path: 'a.ts', line: 3, threadId: 't1' }),
      comment({ id: 3, path: 'a.ts', line: 9, threadId: 't2', isOutdated: true }),
      comment({ id: 4, path: 'b.ts', threadId: 't3' }),
      comment({ id: 5 })
    ])
    expect([...counts]).toEqual([['a.ts', 1]])
  })
})
