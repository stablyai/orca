import { describe, expect, it } from 'vitest'
import { parseGitHubPrReference } from './github-pr-link-parse'

describe('parseGitHubPrReference', () => {
  it('parses bare and #-prefixed numbers', () => {
    expect(parseGitHubPrReference('123')).toBe(123)
    expect(parseGitHubPrReference('#123')).toBe(123)
    expect(parseGitHubPrReference('  #45 ')).toBe(45)
  })

  it('parses GitHub pull and issue URLs', () => {
    expect(parseGitHubPrReference('https://github.com/owner/repo/pull/678')).toBe(678)
    expect(parseGitHubPrReference('https://github.com/o/r/issues/9')).toBe(9)
    expect(parseGitHubPrReference('https://github.com/o/r/pull/678/files')).toBe(678)
  })

  it('rejects empty, non-numeric, non-GitHub, and non-positive input', () => {
    expect(parseGitHubPrReference('')).toBeNull()
    expect(parseGitHubPrReference('abc')).toBeNull()
    expect(parseGitHubPrReference('0')).toBeNull()
    expect(parseGitHubPrReference('-5')).toBeNull()
    expect(parseGitHubPrReference('https://example.com/foo/bar')).toBeNull()
    expect(parseGitHubPrReference('ftp://github.com/o/r/pull/1')).toBeNull()
  })
})
