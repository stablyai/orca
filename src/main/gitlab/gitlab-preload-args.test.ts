import { describe, expect, it } from 'vitest'
import { normalizeGitLabIssueAssignee, normalizeGitLabIssueListArgs } from './gitlab-preload-args'

describe('normalizeGitLabIssueAssignee', () => {
  it('keeps the @me sentinel', () => {
    expect(normalizeGitLabIssueAssignee('@me')).toBe('@me')
  })

  it('accepts a plain GitLab username', () => {
    expect(normalizeGitLabIssueAssignee('orca')).toBe('orca')
  })

  it('strips a leading @ and trims surrounding whitespace', () => {
    expect(normalizeGitLabIssueAssignee('  @orca-bot ')).toBe('orca-bot')
  })

  it('accepts dots, dashes, and underscores within the handle charset', () => {
    expect(normalizeGitLabIssueAssignee('ct.orca_bot-1')).toBe('ct.orca_bot-1')
  })

  it('rejects handles with shell/glob/path characters', () => {
    expect(normalizeGitLabIssueAssignee('orca; rm -rf /')).toBeUndefined()
    expect(normalizeGitLabIssueAssignee('orca/issues')).toBeUndefined()
    expect(normalizeGitLabIssueAssignee('orca bot')).toBeUndefined()
    expect(normalizeGitLabIssueAssignee('*')).toBeUndefined()
  })

  it('rejects empty, non-string, and overlong values', () => {
    expect(normalizeGitLabIssueAssignee('')).toBeUndefined()
    expect(normalizeGitLabIssueAssignee('   ')).toBeUndefined()
    expect(normalizeGitLabIssueAssignee(undefined)).toBeUndefined()
    expect(normalizeGitLabIssueAssignee(42)).toBeUndefined()
    expect(normalizeGitLabIssueAssignee(`a${'b'.repeat(64)}`)).toBeUndefined()
  })
})

describe('normalizeGitLabIssueListArgs', () => {
  it('threads a normalized username assignee through', () => {
    expect(normalizeGitLabIssueListArgs({ state: 'opened', assignee: '@orca', limit: 50 })).toEqual(
      { state: 'opened', assignee: 'orca', limit: 50 }
    )
  })

  it('drops an invalid assignee to undefined without affecting other fields', () => {
    expect(
      normalizeGitLabIssueListArgs({ state: 'all', assignee: 'bad handle', limit: 5 })
    ).toEqual({ state: 'all', assignee: undefined, limit: 5 })
  })
})
