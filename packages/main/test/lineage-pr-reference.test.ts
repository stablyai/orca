import { describe, expect, it } from 'vitest'
import { parsePullRequestReference } from '../../../src/shared/lineage-pr-reference'

describe('parsePullRequestReference', () => {
  it('parses a GitHub pull request URL', () => {
    expect(parsePullRequestReference('https://github.com/neon/loan-core/pull/12')).toEqual({
      repoName: 'loan-core',
      number: 12,
      url: 'https://github.com/neon/loan-core/pull/12',
      provider: 'github',
      owner: 'neon',
      host: 'github.com'
    })
  })
  it('parses a GitLab merge request URL', () => {
    expect(parsePullRequestReference('https://gitlab.com/g/sub/proj/-/merge_requests/4')).toEqual({
      repoName: 'proj',
      number: 4,
      url: 'https://gitlab.com/g/sub/proj/-/merge_requests/4',
      provider: 'gitlab',
      owner: 'g/sub',
      host: 'gitlab.com'
    })
  })
  it('parses repo#number', () => {
    expect(parsePullRequestReference('loan-core#12')).toEqual({ repoName: 'loan-core', number: 12 })
  })
  it('rejects malformed input', () => {
    expect(parsePullRequestReference('')).toBeNull()
    expect(parsePullRequestReference('loan-core#abc')).toBeNull()
    expect(parsePullRequestReference('https://example.com/x')).toBeNull()
  })
})
