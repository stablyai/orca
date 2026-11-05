import { describe, expect, it } from 'vitest'
import { linkedIssueNumberForTemplate } from './linked-issue-provider'

describe('linkedIssueNumberForTemplate', () => {
  it('returns the GitLab issue when it is the only forge issue linked', () => {
    expect(linkedIssueNumberForTemplate({ linkedIssue: null, linkedGitLabIssue: 7 })).toBe(7)
  })

  it('uses the requested provider to pick between two linked forge issues', () => {
    const meta = { linkedIssue: 12, linkedGitLabIssue: 7 }
    expect(linkedIssueNumberForTemplate(meta, 'gitlab')).toBe(7)
    expect(linkedIssueNumberForTemplate(meta, 'github')).toBe(12)
  })

  it('stays empty when two forge issues are linked and nothing breaks the tie', () => {
    expect(linkedIssueNumberForTemplate({ linkedIssue: 12, linkedGitLabIssue: 7 })).toBeNull()
  })
})
