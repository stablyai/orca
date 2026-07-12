import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../src/shared/types'
import {
  createBotAuthorOverrideSet,
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  isBotPRComment
} from './pr-comment-audience'
import { groupPRComments, isResolvedPRCommentGroup } from './pr-comment-groups'
import { formatPrCommentRelativeTime } from './pr-comment-time'

function comment(overrides: Partial<PRComment> & { id: number }): PRComment {
  return {
    author: 'octocat',
    authorAvatarUrl: '',
    body: '',
    createdAt: '',
    url: '',
    ...overrides
  }
}

describe('pr comment audience', () => {
  it('classifies app bots, [bot] suffix, and known automation logins', () => {
    expect(isBotPRComment(comment({ id: 1, author: 'alice' }))).toBe(false)
    expect(isBotPRComment(comment({ id: 2, author: 'alice', isBot: true }))).toBe(true)
    expect(isBotPRComment(comment({ id: 3, author: 'renovate[bot]' }))).toBe(true)
    expect(isBotPRComment(comment({ id: 4, author: 'coderabbitai' }))).toBe(true)
  })

  it('counts and filters by audience', () => {
    const comments = [
      comment({ id: 1, author: 'alice' }),
      comment({ id: 2, author: 'dependabot[bot]' }),
      comment({ id: 3, author: 'bob' })
    ]
    expect(getPRCommentAudienceCounts(comments)).toEqual({ all: 3, human: 2, bot: 1 })
    expect(filterPRCommentsByAudience(comments, 'bot').map((c) => c.id)).toEqual([2])
    expect(filterPRCommentsByAudience(comments, 'human').map((c) => c.id)).toEqual([1, 3])
    expect(filterPRCommentsByAudience(comments, 'all')).toHaveLength(3)
  })

  it('classifies desktop-marked bot authors via overrides (desktop parity)', () => {
    const overrides = createBotAuthorOverrideSet([' GretelFlux '])
    const comments = [comment({ id: 1, author: 'alice' }), comment({ id: 2, author: 'gretelflux' })]
    expect(isBotPRComment(comments[1])).toBe(false)
    expect(isBotPRComment(comments[1], overrides)).toBe(true)
    expect(getPRCommentAudienceCounts(comments, overrides)).toEqual({ all: 2, human: 1, bot: 1 })
    expect(filterPRCommentsByAudience(comments, 'bot', overrides).map((c) => c.id)).toEqual([2])
  })
})

describe('pr comment groups', () => {
  it('threads comments sharing a threadId as root + replies, preserving order', () => {
    const comments = [
      comment({ id: 1, author: 'a' }),
      comment({ id: 2, author: 'b', threadId: 't1', isResolved: true }),
      comment({ id: 3, author: 'c', threadId: 't1' })
    ]
    const groups = groupPRComments(comments)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toEqual({ kind: 'standalone', comment: comments[0] })
    expect(groups[1].kind).toBe('thread')
    if (groups[1].kind === 'thread') {
      expect(groups[1].root.id).toBe(2)
      expect(groups[1].replies.map((r) => r.id)).toEqual([3])
    }
    expect(isResolvedPRCommentGroup(groups[1])).toBe(true)
  })
})

describe('pr comment relative time', () => {
  const now = Date.parse('2026-06-16T12:00:00Z')
  it('formats buckets and rejects bad input', () => {
    expect(formatPrCommentRelativeTime('2026-06-16T11:59:30Z', now)).toBe('just now')
    expect(formatPrCommentRelativeTime('2026-06-16T11:30:00Z', now)).toBe('30m ago')
    expect(formatPrCommentRelativeTime('2026-06-16T09:00:00Z', now)).toBe('3h ago')
    expect(formatPrCommentRelativeTime('2026-06-10T12:00:00Z', now)).toBe('6d ago')
    expect(formatPrCommentRelativeTime('not-a-date', now)).toBe('')
  })
})
