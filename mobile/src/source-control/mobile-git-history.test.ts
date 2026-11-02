import { describe, expect, it } from 'vitest'
import type { GitHistoryItem, GitHistoryResult } from '../../../src/shared/git-history-types'
import {
  appendMobileGitHistoryPage,
  buildMobileCommitsListItems,
  buildMobileCommitsView,
  formatCommitTime,
  mapMobileCommitRows,
  toMobileCommitRow
} from './mobile-git-history'
import { branchCommitsSinceBase } from './mobile-pr-create-draft'
import type { MobileGitHistoryResult } from './git-history-reply-schema'

const NOW = 1_000_000_000_000

function item(overrides: Partial<GitHistoryItem> = {}): GitHistoryItem {
  return {
    id: 'a'.repeat(40),
    parentIds: ['b'.repeat(40)],
    subject: 'feat: thing',
    message: 'feat: thing\n\nbody',
    author: 'Jane',
    timestamp: NOW - 3_600_000,
    ...overrides
  }
}

describe('formatCommitTime', () => {
  it('formats across thresholds from epoch-millisecond timestamps', () => {
    const ms = { min: 60_000, hour: 3_600_000, day: 86_400_000 }
    expect(formatCommitTime(NOW - 3 * ms.hour, NOW)).toBe('3h')
    expect(formatCommitTime(NOW - 30_000, NOW)).toBe('just now')
    expect(formatCommitTime(NOW - 5 * ms.min, NOW)).toBe('5m')
    expect(formatCommitTime(NOW - 2 * ms.day, NOW)).toBe('2d')
    expect(formatCommitTime(NOW - 60 * ms.day, NOW)).toBe('2mo')
    expect(formatCommitTime(NOW - 800 * ms.day, NOW)).toBe('2y')
  })

  it('returns empty for missing timestamp', () => {
    expect(formatCommitTime(undefined, NOW)).toBe('')
  })

  it('formats a real epoch-0 timestamp instead of dropping it', () => {
    // Epoch zero is valid, not missing.
    expect(formatCommitTime(0, NOW)).not.toBe('')
  })
})

describe('toMobileCommitRow', () => {
  it('maps a history item to a row', () => {
    const row = toMobileCommitRow(item(), NOW)
    expect(row).toEqual({
      id: 'a'.repeat(40),
      shortId: 'aaaaaaa',
      subject: 'feat: thing',
      author: 'Jane',
      parentId: 'b'.repeat(40),
      relativeTime: '1h'
    })
  })

  it('prefers displayId and falls back for empty subject / no parent', () => {
    const row = toMobileCommitRow(item({ displayId: 'abc1234', subject: '', parentIds: [] }), NOW)
    expect(row.shortId).toBe('abc1234')
    expect(row.subject).toBe('(no commit message)')
    expect(row.parentId).toBeNull()
  })
})

describe('mapMobileCommitRows', () => {
  it('maps all items', () => {
    const result = { items: [item(), item({ id: 'c'.repeat(40) })] } as GitHistoryResult
    expect(mapMobileCommitRows(result, NOW)).toHaveLength(2)
  })
})

describe('branch-only commit pages', () => {
  const branch = {
    baseRef: { name: 'origin/main', category: 'remote branches' },
    ahead: 3,
    behind: 12,
    unpushed: 1
  }
  function page(ids: string[], extra: Partial<MobileGitHistoryResult>): MobileGitHistoryResult {
    return {
      items: ids.map((id) => item({ id, subject: id, pushed: id.startsWith('p') })),
      ...extra
    }
  }

  it('stops paging on hosts that ignore skip, so page one is never repeated', () => {
    const pages = appendMobileGitHistoryPage(null, page(['u1'], { hasMore: true }))
    expect(pages.hasMore).toBe(false)
  })

  it('groups by pushed state and ends at the base only after the last page', () => {
    const first = appendMobileGitHistoryPage(
      null,
      page(['u1', 'p1'], { branch, hasMore: true, skip: 0 })
    )
    const firstItems = buildMobileCommitsListItems(buildMobileCommitsView(first, NOW))
    expect(firstItems.map((entry) => entry.key)).toEqual(['not-pushed', 'u1', 'on-origin', 'p1'])

    // HEAD moved between pages: the repeated commit is dropped.
    const last = appendMobileGitHistoryPage(first, page(['p1', 'p2'], { branch, skip: 2 }))
    // The next page starts past what the host served, not past the rows kept after dedupe.
    expect(last.nextSkip).toBe(4)
    const items = buildMobileCommitsListItems(buildMobileCommitsView(last, NOW))
    expect(items.map((entry) => entry.key)).toEqual([
      'not-pushed',
      'u1',
      'on-origin',
      'p1',
      'p2',
      'base'
    ])
    expect(items.at(-1)).toMatchObject({
      kind: 'base',
      baseRefName: 'origin/main',
      behind: 12,
      canUpdateFromBase: true
    })
    expect(items.filter((entry) => entry.kind === 'section').map((entry) => entry.title)).toEqual([
      'Not pushed 1',
      'On origin 2'
    ])
  })

  it('shows older hosts their full history without groups or a base marker', () => {
    const pages = appendMobileGitHistoryPage(null, page(['a', 'b'], {}))
    const items = buildMobileCommitsListItems(buildMobileCommitsView(pages, NOW))
    expect(items.map((entry) => [entry.kind, entry.kind === 'commit' && entry.pushed])).toEqual([
      ['commit', null],
      ['commit', null]
    ])
  })
})

describe('branchCommitsSinceBase', () => {
  const item = (id: string, parentIds: string[], subject = id) => ({ id, parentIds, subject })

  it("gives up on merged history rather than list the base's commits as the branch's own", () => {
    // git log --topo-order after `git merge main` on a two-commit branch; rev-list main..HEAD counts 3.
    const history = {
      items: [
        item('merge', ['two', 'mainB']),
        item('mainB', ['mainA']),
        item('mainA', ['base']),
        item('two', ['one']),
        item('one', ['base']),
        item('base', [])
      ]
    }
    expect(branchCommitsSinceBase(history, 3)).toEqual([])
    const linear = { items: [item('two', ['one']), item('one', ['base']), item('base', [])] }
    expect(branchCommitsSinceBase(linear, 2).map((commit) => commit.id)).toEqual(['two', 'one'])
  })

  it('knows no commits without the base compare', () => {
    expect(branchCommitsSinceBase({ items: [item('a', ['b'])] }, null)).toEqual([])
  })
})
