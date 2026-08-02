import { describe, expect, it } from 'vitest'
import {
  buildWorkItemSearchQuery,
  estimateWorkItemSearchRequestBytes,
  splitWorkItemSearchRepositories,
  type WorkItemSearchRepository
} from './work-item-search-query'
import { parseTaskQuery } from '../../shared/task-query'

const repositories: WorkItemSearchRepository[] = [
  { owner: 'acme', repo: 'zeta' },
  { owner: 'acme', repo: 'alpha' }
]

describe('GitHub cross-repository work-item search queries', () => {
  it('builds one scoped query with stable repository ordering and filters', () => {
    expect(
      buildWorkItemSearchQuery(
        repositories,
        parseTaskQuery('is:open label:"needs review" author:@me roadmap'),
        'all'
      )
    ).toBe('repo:acme/alpha repo:acme/zeta is:open author:@me label:"needs review" roadmap')
  })

  it('adds type and PR-only filters only to the requested scope', () => {
    const query = parseTaskQuery('is:closed is:draft review-requested:"octo bot"')

    expect(buildWorkItemSearchQuery(repositories, query, 'issue')).toBe(
      'repo:acme/alpha repo:acme/zeta is:issue is:open'
    )
    expect(buildWorkItemSearchQuery(repositories, query, 'pr')).toBe(
      'repo:acme/alpha repo:acme/zeta is:pr is:open draft:true review-requested:"octo bot"'
    )
  })

  it('rejects an empty qualifier set instead of creating an unscoped search', () => {
    expect(() => buildWorkItemSearchQuery([], parseTaskQuery('is:open'), 'all')).toThrow(
      'at least one repository'
    )
  })

  it('splits only at repository boundaries and keeps every qualifier exactly once', () => {
    const query = parseTaskQuery('is:open')
    const chunks = splitWorkItemSearchRepositories(repositories, query, 'all', {
      maxRequestBytes:
        estimateWorkItemSearchRequestBytes(
          buildWorkItemSearchQuery([repositories[0]], query, 'all'),
          1,
          100
        ) + 1
    })

    expect(chunks).toEqual([[{ owner: 'acme', repo: 'alpha' }], [{ owner: 'acme', repo: 'zeta' }]])
    expect(chunks.flat()).toEqual([
      { owner: 'acme', repo: 'alpha' },
      { owner: 'acme', repo: 'zeta' }
    ])
  })

  it('accounts for encoded URL bytes, not JavaScript character count', () => {
    const plain = 'repo:acme/alpha freetextx'
    const encoded = 'repo:acme/alpha "free tex"'
    expect(estimateWorkItemSearchRequestBytes(encoded, 1, 100)).toBeGreaterThan(
      estimateWorkItemSearchRequestBytes(plain, 1, 100)
    )
  })

  it('quotes qualifier values containing search syntax', () => {
    expect(
      buildWorkItemSearchQuery(
        repositories,
        parseTaskQuery('label:type:bug assignee:octo/bot'),
        'issue'
      )
    ).toContain('label:"type:bug"')
    expect(
      buildWorkItemSearchQuery(
        repositories,
        parseTaskQuery('label:type:bug assignee:octo/bot'),
        'issue'
      )
    ).toContain('assignee:octo/bot')
  })

  it('checks a later repository against the solo request budget', () => {
    const first = { owner: 'acme', repo: 'alpha' }
    const oversized = { owner: 'z'.repeat(1_000), repo: 'repo' }
    const query = parseTaskQuery('is:open')
    const maxRequestBytes = estimateWorkItemSearchRequestBytes(
      buildWorkItemSearchQuery([first], query, 'all'),
      1,
      100
    )

    expect(() =>
      splitWorkItemSearchRepositories([first, oversized], query, 'all', {
        maxRequestBytes
      })
    ).toThrow('exceeds Search API request budget')
  })
})
