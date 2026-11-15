import { describe, expect, it } from 'vitest'
import { parseTaskQuery } from '../../../../shared/work-items/task-query'
import { buildWorkItemListRequest } from './work-item-list-request'

const ownerRepo = { owner: 'acme', repo: 'widgets' }

describe('buildWorkItemListRequest', () => {
  it('ORs several authors in the grammar each GitHub search understands', () => {
    const query = parseTaskQuery('is:open author:alice author:bob')
    const issues = buildWorkItemListRequest({ kind: 'issue', ownerRepo, limit: 20, query, page: 1 })
    const prs = buildWorkItemListRequest({ kind: 'pr', ownerRepo, limit: 20, query, page: 1 })

    expect(issues.search).toBe('repo:acme/widgets is:issue is:open author:alice author:bob')
    expect(prs.search).toBe(
      '( is:open (author:alice OR author:bob) sort:created-desc ) repo:acme/widgets type:pr'
    )
    expect(prs.args.at(prs.args.indexOf('--search') + 1)).toBe(
      'is:open (author:alice OR author:bob) sort:created-desc'
    )
  })
})
