import { describe, expect, it } from 'vitest'
import { getOptionalGitLabLinkFlag } from './worktree-gitlab-link'

function flags(entries: Record<string, string | boolean>): Map<string, string | boolean> {
  return new Map(Object.entries(entries))
}

describe('getOptionalGitLabLinkFlag', () => {
  it('leaves the slot alone when the flag is absent', () => {
    expect(getOptionalGitLabLinkFlag(flags({}), 'issue')).toBeUndefined()
    expect(getOptionalGitLabLinkFlag(flags({}), 'mr')).toBeUndefined()
  })

  it.each([
    ['42', 42],
    ['#42', 42],
    ['  7  ', 7]
  ])('reads the issue reference %s', (input, expected) => {
    expect(getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': input }), 'issue')).toBe(expected)
  })

  it.each([
    ['77', 77],
    ['!77', 77]
  ])('reads the merge request reference %s', (input, expected) => {
    expect(getOptionalGitLabLinkFlag(flags({ 'gitlab-mr': input }), 'mr')).toBe(expected)
  })

  it('reads a self-hosted issue URL, including a subgroup path', () => {
    expect(
      getOptionalGitLabLinkFlag(
        flags({ 'gitlab-issue': 'https://gitlab.critel.li/group/sub/project/-/issues/923' }),
        'issue'
      )
    ).toBe(923)
  })

  it('reads a merge request URL with trailing segments', () => {
    expect(
      getOptionalGitLabLinkFlag(
        flags({ 'gitlab-mr': 'https://gitlab.com/group/project/-/merge_requests/77/diffs' }),
        'mr'
      )
    ).toBe(77)
  })

  // Issues and merge requests are separate namespaces on GitLab, so a reference
  // to one must never be taken as the other's number.
  it('refuses a merge request reference in the issue flag', () => {
    expect(() => getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': '!42' }), 'issue')).toThrow(
      /GitLab issue number/
    )
    expect(() =>
      getOptionalGitLabLinkFlag(
        flags({ 'gitlab-issue': 'https://gitlab.com/g/p/-/merge_requests/42' }),
        'issue'
      )
    ).toThrow(/GitLab issue number/)
  })

  it('refuses an issue reference in the merge request flag', () => {
    expect(() => getOptionalGitLabLinkFlag(flags({ 'gitlab-mr': '#42' }), 'mr')).toThrow(
      /merge request number/
    )
    expect(() =>
      getOptionalGitLabLinkFlag(flags({ 'gitlab-mr': 'https://gitlab.com/g/p/-/issues/42' }), 'mr')
    ).toThrow(/merge request number/)
  })

  it('clears the slot on set, and refuses to on create', () => {
    expect(
      getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': 'null' }), 'issue', { allowNull: true })
    ).toBeNull()
    expect(
      getOptionalGitLabLinkFlag(flags({ 'gitlab-mr': 'NULL' }), 'mr', { allowNull: true })
    ).toBeNull()
    expect(() => getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': 'null' }), 'issue')).toThrow(
      /Omit --gitlab-issue on create/
    )
  })

  it('reports a flag given without a value', () => {
    expect(() => getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': true }), 'issue')).toThrow(
      'Missing value for --gitlab-issue'
    )
  })

  it.each(['', '   ', '0', '-1', '4 2', '42x', 'STA-335', 'https://gitlab.com/g/p/-/issues/abc'])(
    'refuses %s',
    (input) => {
      expect(() => getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': input }), 'issue')).toThrow()
    }
  )

  // A URL without GitLab's `/-/` separator is not a GitLab link, and a project
  // path needs a group segment — neither may fall through to a number.
  it.each(['https://gitlab.com/group/project/issues/42', 'https://gitlab.com/project/-/issues/42'])(
    'refuses the non-GitLab URL shape %s',
    (input) => {
      expect(() => getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': input }), 'issue')).toThrow()
    }
  )

  // `/^\d+$/` accepts 400 digits, which parseInt turns into Infinity — persisting
  // that writes `null` over the link it meant to set.
  it('refuses a number too large to be an integer', () => {
    expect(() =>
      getOptionalGitLabLinkFlag(flags({ 'gitlab-issue': '9'.repeat(400) }), 'issue')
    ).toThrow()
  })
})
