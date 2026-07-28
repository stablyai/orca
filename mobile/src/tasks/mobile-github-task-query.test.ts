import { describe, expect, it } from 'vitest'
import { getTaskPresetQuery, scopeGitHubTaskSearch } from '../../../src/shared/github-task-query'
import { resolveMobileGitHubTaskKind } from './mobile-github-task-kind'

describe('mobile GitHub task query parity', () => {
  it.each([
    ['issues', 'is:issue is:open'],
    ['my-issues', 'assignee:@me is:issue is:open'],
    ['prs', 'is:pr is:open'],
    ['my-prs', 'author:@me is:pr is:open'],
    ['review', 'review-requested:@me is:pr is:open']
  ] as const)('keeps the %s preset aligned with desktop', (preset, expected) => {
    expect(getTaskPresetQuery(preset)).toBe(expected)
  })

  it.each([
    ['is:issue bug', 'prs', 'issues'],
    ['is:pr bug', 'issues', 'prs'],
    ['is:pull-request bug', 'issues', 'prs'],
    ['review-requested:@me', 'issues', 'prs'],
    ['"is:pull-request"', 'issues', 'issues'],
    ['label:"is:issue"', 'prs', 'prs']
  ] as const)('resolves %s from the mobile parser', (query, fallback, expected) => {
    expect(resolveMobileGitHubTaskKind(query, fallback)).toBe(expected)
  })

  it('preserves explicit aliases when scoping the mobile query', () => {
    expect(scopeGitHubTaskSearch('is:pull-request bug', 'issues')).toBe('is:pull-request bug')
  })
})
