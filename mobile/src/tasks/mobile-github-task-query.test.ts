import { describe, expect, it } from 'vitest'
import { getTaskPresetQuery, scopeGitHubTaskSearch } from '../../../src/shared/task-query'

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
    ['is:issue bug', 'prs'],
    ['is:pr bug', 'issues'],
    ['is:pull-request bug', 'issues']
  ] as const)('preserves the %s scope alias', (query, kind) => {
    expect(scopeGitHubTaskSearch(query, kind)).toBe(query)
  })
})
