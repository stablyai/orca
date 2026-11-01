import { describe, expect, it } from 'vitest'
import { getReviewTargetLinkFlags } from './worktree-review-link-flags'

describe('getReviewTargetLinkFlags Gitea flags', () => {
  it('parses --gitea-pr and --gitea-issue as separate links', () => {
    const flags = new Map<string, string | boolean>([
      ['gitea-pr', '12'],
      ['gitea-issue', '34']
    ])
    expect(getReviewTargetLinkFlags(flags)).toMatchObject({
      linkedGiteaPR: 12,
      linkedGiteaIssue: 34
    })
  })

  it('clears Gitea links with null on set only', () => {
    const flags = new Map<string, string | boolean>([['gitea-pr', 'null']])
    expect(getReviewTargetLinkFlags(flags, { nullable: true })).toMatchObject({
      linkedGiteaPR: null
    })
    expect(() => getReviewTargetLinkFlags(flags)).toThrow(/Omit --gitea-pr/)
  })

  it('rejects non-positive or non-numeric Gitea numbers', () => {
    expect(() => getReviewTargetLinkFlags(new Map([['gitea-issue', '0']]))).toThrow(
      /positive safe integer for --gitea-issue/
    )
    expect(() => getReviewTargetLinkFlags(new Map([['gitea-pr', 'abc']]))).toThrow(
      /positive safe integer for --gitea-pr/
    )
  })

  it('omits Gitea fields when the flags are absent', () => {
    const links = getReviewTargetLinkFlags(new Map())
    expect(links).not.toHaveProperty('linkedGiteaPR')
    expect(links).not.toHaveProperty('linkedGiteaIssue')
  })
})
