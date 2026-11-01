import { describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-tasks-dependencies', () => ({ colors: {} }))

import {
  githubKindFromQuery,
  scopeGitHubTaskSearch,
  normalizeGitHubPreset,
  getTaskPresetQuery
} from './mobile-tasks-item-mapping'

describe('mobile task search parity', () => {
  it('lets an explicit issue query override a saved PR preset', () => {
    for (const preset of ['prs', 'my-prs', 'review'] as const) {
      expect(githubKindFromQuery('is:issue is:open', preset)).toBe('issues')
      expect(githubKindFromQuery('is:"issue" is:open', preset)).toBe('issues')
      expect(scopeGitHubTaskSearch('is:issue is:open', 'prs')).toBe('is:issue is:open')
    }
  })

  it('preserves the pull-request alias while browsing issues', () => {
    expect(scopeGitHubTaskSearch('is:pull-request is:open', 'issues')).toBe(
      'is:pull-request is:open'
    )
    expect(githubKindFromQuery('is:pull-request is:open', 'issues')).toBe('prs')
  })

  it('opens the PR tab for draft and review searches', () => {
    for (const query of ['is:draft', 'reviewed-by:@me', 'review-requested:@me', 'is:merged']) {
      expect(githubKindFromQuery(query, 'issues')).toBe('prs')
      expect(scopeGitHubTaskSearch(query, 'issues')).toBe(`is:pr ${query}`)
    }
  })

  it('does not read scope qualifiers out of labels or quoted search text', () => {
    expect(scopeGitHubTaskSearch('label:is:pr', 'issues')).toBe('is:issue label:is:pr')
    expect(scopeGitHubTaskSearch('"is:pull-request"', 'issues')).toBe('is:issue "is:pull-request"')
    expect(githubKindFromQuery('"is:pr"', 'issues')).toBe('issues')
    expect(scopeGitHubTaskSearch('is:"pr"', 'issues')).toBe('is:"pr"')
  })

  it('uses the current split-tab fallback for a legacy all preset', () => {
    const preset = normalizeGitHubPreset('all')
    expect(preset).toBe('issues')
    expect(getTaskPresetQuery(preset)).toBe('is:issue is:open')
  })
})
