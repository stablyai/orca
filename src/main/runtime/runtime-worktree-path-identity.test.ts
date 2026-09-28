import { describe, expect, it } from 'vitest'

import { issueSelectorMatches } from './runtime-worktree-path-identity'

describe('issueSelectorMatches', () => {
  it('matches a GitHub-linked workspace', () => {
    expect(issueSelectorMatches({ linkedIssue: 42, linkedGitLabIssue: null }, '42')).toBe(true)
  })

  it('matches a GitLab-linked workspace', () => {
    expect(issueSelectorMatches({ linkedIssue: null, linkedGitLabIssue: 42 }, '42')).toBe(true)
  })

  it('does not match a different number in either slot', () => {
    expect(issueSelectorMatches({ linkedIssue: 7, linkedGitLabIssue: 9 }, '42')).toBe(false)
  })

  // An unhydrated projection leaves the slot undefined, which `!== null` would
  // have read as a link and then stringified to "undefined".
  it('treats missing and null slots as unlinked', () => {
    expect(issueSelectorMatches({ linkedIssue: null, linkedGitLabIssue: null }, '42')).toBe(false)
    expect(issueSelectorMatches({}, '42')).toBe(false)
    expect(issueSelectorMatches({}, 'undefined')).toBe(false)
  })
})
