import { describe, expect, it } from 'vitest'
import { formatBadges } from './worktree-badge-format'
import type { WorktreeBadges } from './worktree-snapshot'

function badges(overrides: Partial<WorktreeBadges> = {}): WorktreeBadges {
  return {
    unread: false,
    liveTerminalCount: 0,
    issue: null,
    pr: null,
    gitLabMr: null,
    gitLabIssue: null,
    linearIssue: null,
    ...overrides
  }
}

describe('formatBadges', () => {
  it('renders a GitHub PR link', () => {
    expect(formatBadges(badges({ pr: { number: 418, state: 'open' } }))).toBe('#418')
  })

  it('renders a GitLab MR link when no PR is present', () => {
    expect(formatBadges(badges({ gitLabMr: 22 }))).toBe('!22')
  })

  it('renders a Linear issue identifier', () => {
    expect(formatBadges(badges({ linearIssue: 'STA-335' }))).toBe('STA-335')
  })

  it('prefers a PR over a bare issue link', () => {
    expect(formatBadges(badges({ pr: { number: 7, state: 'open' }, issue: 9 }))).toBe('#7')
  })

  it('appends terminal count and unread marker', () => {
    expect(formatBadges(badges({ liveTerminalCount: 3, unread: true }))).toBe('⌗3 •')
  })

  it('is empty when there is nothing to show', () => {
    expect(formatBadges(badges())).toBe('')
  })
})
