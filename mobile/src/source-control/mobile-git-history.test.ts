import { describe, expect, it } from 'vitest'
import type { GitHistoryItem, GitHistoryResult } from '../../../src/shared/git-history-types'
import { formatCommitTime, mapMobileCommitRows, toMobileCommitRow } from './mobile-git-history'

const NOW = 1_000_000_000_000

function item(overrides: Partial<GitHistoryItem> = {}): GitHistoryItem {
  return {
    id: 'a'.repeat(40),
    parentIds: ['b'.repeat(40)],
    subject: 'feat: thing',
    message: 'feat: thing\n\nbody',
    author: 'Jane',
    timestamp: NOW / 1000 - 3600,
    ...overrides
  }
}

describe('formatCommitTime', () => {
  it('formats across thresholds', () => {
    const s = NOW / 1000
    expect(formatCommitTime(s - 30, NOW)).toBe('just now')
    expect(formatCommitTime(s - 5 * 60, NOW)).toBe('5m')
    expect(formatCommitTime(s - 3 * 3600, NOW)).toBe('3h')
    expect(formatCommitTime(s - 2 * 86400, NOW)).toBe('2d')
    expect(formatCommitTime(s - 60 * 86400, NOW)).toBe('2mo')
    expect(formatCommitTime(s - 800 * 86400, NOW)).toBe('2y')
  })

  it('returns empty for missing timestamp', () => {
    expect(formatCommitTime(undefined, NOW)).toBe('')
  })

  it('formats a real epoch-0 timestamp instead of dropping it', () => {
    // 0 is a valid (very old) timestamp, not "missing".
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
