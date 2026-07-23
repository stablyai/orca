import { describe, expect, it, vi } from 'vitest'
import { IntegrationPaginationBudget } from '../integration-pagination-budget'
import { readConnectionPages } from './issue-context-pagination'

describe('Linear issue context pagination', () => {
  it('stops before retaining a page that exceeds the aggregate byte budget', async () => {
    const loadConnection = vi
      .fn()
      .mockResolvedValueOnce({
        nodes: [{ id: 'first', body: 'small' }],
        pageInfo: { hasNextPage: true, endCursor: 'next' }
      })
      .mockResolvedValueOnce({
        nodes: [{ id: 'second', body: 'x'.repeat(100) }],
        pageInfo: { hasNextPage: false, endCursor: null }
      })
    const budget = new IntegrationPaginationBudget({
      maxPages: 10,
      maxItems: 10,
      maxRetainedBytes: 64
    })

    await expect(readConnectionPages(10, loadConnection, budget)).resolves.toEqual({
      nodes: [{ id: 'first', body: 'small' }],
      hasMore: true
    })
    expect(loadConnection).toHaveBeenCalledTimes(2)
  })

  it('reports truncation when a backend over-delivers the requested page', async () => {
    await expect(
      readConnectionPages(1, async () => ({
        nodes: [{ id: 'first' }, { id: 'omitted' }],
        pageInfo: { hasNextPage: false, endCursor: null }
      }))
    ).resolves.toEqual({
      nodes: [{ id: 'first' }],
      hasMore: true
    })
  })
})
