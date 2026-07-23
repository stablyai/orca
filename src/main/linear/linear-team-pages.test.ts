import { describe, expect, it, vi } from 'vitest'
import {
  INTEGRATION_PAGINATION_MAX_ITEMS,
  INTEGRATION_PAGINATION_MAX_PAGES,
  IntegrationPaginationLimitError
} from '../integration-pagination-budget'
import { fetchAllTeamLabels } from './linear-team-pages'

function label(index: number) {
  return { id: `label-${index}`, name: `Label ${index}`, color: '#888888' }
}

function cumulativeLabelPage(totalPages: number, advertisesOneMore = false) {
  let pageNumber = 1
  const page = {
    nodes: [label(1)],
    pageInfo: { hasNextPage: totalPages > 1 || advertisesOneMore },
    fetchNext: vi.fn(async () => {
      pageNumber += 1
      page.nodes.push(label(pageNumber))
      page.pageInfo.hasNextPage = pageNumber < totalPages || advertisesOneMore
      return page
    })
  }
  return page
}

describe('bounded Linear team metadata pagination', () => {
  it('preserves cumulative node order through the exact page boundary', async () => {
    const page = cumulativeLabelPage(INTEGRATION_PAGINATION_MAX_PAGES)

    const labels = await fetchAllTeamLabels({ labels: async () => page })
    expect(labels).toHaveLength(INTEGRATION_PAGINATION_MAX_PAGES)
    expect(labels[0]).toMatchObject({ id: 'label-1' })
    expect(labels.at(-1)).toMatchObject({ id: `label-${INTEGRATION_PAGINATION_MAX_PAGES}` })
    expect(page.fetchNext).toHaveBeenCalledTimes(INTEGRATION_PAGINATION_MAX_PAGES - 1)
  })

  it('rejects page +1 before asking the SDK to materialize it', async () => {
    const page = cumulativeLabelPage(INTEGRATION_PAGINATION_MAX_PAGES, true)

    await expect(fetchAllTeamLabels({ labels: async () => page })).rejects.toThrow(
      IntegrationPaginationLimitError
    )
    expect(page.fetchNext).toHaveBeenCalledTimes(INTEGRATION_PAGINATION_MAX_PAGES - 1)
  })

  it('admits the exact item boundary and rejects item +1', async () => {
    const exact = {
      nodes: Array.from({ length: INTEGRATION_PAGINATION_MAX_ITEMS }, (_, index) => label(index)),
      pageInfo: { hasNextPage: false },
      fetchNext: vi.fn()
    }
    const over = {
      ...exact,
      nodes: [...exact.nodes, label(INTEGRATION_PAGINATION_MAX_ITEMS)]
    }

    await expect(fetchAllTeamLabels({ labels: async () => exact })).resolves.toHaveLength(
      INTEGRATION_PAGINATION_MAX_ITEMS
    )
    await expect(fetchAllTeamLabels({ labels: async () => over })).rejects.toThrow(
      IntegrationPaginationLimitError
    )
  })
})
