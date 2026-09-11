import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchProjectViewsPage, type RawProjectView } from './project-view-config'
import type * as ProjectViewConfig from './project-view-config'
import { fetchAllItems, fetchItemsCountOnly } from './project-view-items'
import { getProjectViewTable } from './project-view-table'

vi.mock('./project-view-config', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectViewConfig>()),
  fetchProjectViewsPage: vi.fn()
}))
vi.mock('./project-view-items', () => ({
  fetchAllItems: vi.fn(),
  fetchItemsCountOnly: vi.fn()
}))

const args = {
  owner: 'acme',
  ownerType: 'organization',
  projectNumber: 1,
  host: 'github.acme.test'
} as const
const view = (id: string, layout: string): RawProjectView => ({
  id,
  number: 1,
  name: id,
  layout,
  filter: 'status:open',
  fields: { nodes: [] },
  groupByFields: { nodes: [] },
  sortByFields: { nodes: [] }
})
function page(views: RawProjectView[], hasNextPage = false) {
  return {
    ok: true as const,
    project: { id: 'project', title: 'Plan', url: 'https://github.acme.test/orgs/acme/projects/1' },
    views,
    hasNextPage,
    endCursor: hasNextPage ? 'next' : null
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(fetchAllItems).mockResolvedValue({
    ok: true,
    rows: [],
    totalCount: 0,
    parentFieldDropped: false
  })
  vi.mocked(fetchItemsCountOnly).mockResolvedValue(12)
})

describe('project view layout selection', () => {
  it('fetches roadmap items with the selected host and filter', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('roadmap', 'ROADMAP_LAYOUT')]))
    const result = await getProjectViewTable({ ...args, viewId: 'roadmap' })
    expect(result).toMatchObject({ ok: true, data: { selectedView: { layout: 'ROADMAP_LAYOUT' } } })
    expect(fetchAllItems).toHaveBeenCalledWith({ ...args, query: 'status:open' })
    expect(fetchItemsCountOnly).not.toHaveBeenCalled()
  })

  it('defaults to a roadmap when no table exists across all view pages', async () => {
    vi.mocked(fetchProjectViewsPage)
      .mockResolvedValueOnce(page([view('roadmap', 'ROADMAP_LAYOUT')], true))
      .mockResolvedValueOnce(page([view('board', 'BOARD_LAYOUT')]))
    expect(await getProjectViewTable(args)).toMatchObject({
      ok: true,
      data: { selectedView: { id: 'roadmap' } }
    })
    expect(fetchProjectViewsPage).toHaveBeenLastCalledWith({ ...args, after: 'next' })
  })

  it('prefers a table on a later page over an earlier roadmap', async () => {
    vi.mocked(fetchProjectViewsPage)
      .mockResolvedValueOnce(page([view('roadmap', 'ROADMAP_LAYOUT')], true))
      .mockResolvedValueOnce(page([view('table', 'TABLE_LAYOUT')]))
    expect(await getProjectViewTable(args)).toMatchObject({
      ok: true,
      data: { selectedView: { id: 'table' } }
    })
  })

  it('does not substitute a roadmap for a missing explicit selection', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('roadmap', 'ROADMAP_LAYOUT')]))
    expect(await getProjectViewTable({ ...args, viewId: 'missing' })).toMatchObject({
      ok: false,
      error: { type: 'not_found' }
    })
    expect(fetchAllItems).not.toHaveBeenCalled()
  })

  it.each(['BOARD_LAYOUT', 'FUTURE_LAYOUT'])(
    'rejects %s without fetching items',
    async (layout) => {
      vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('unsupported', layout)]))
      expect(
        await getProjectViewTable({ ...args, viewId: 'unsupported', queryOverride: '' })
      ).toMatchObject({
        ok: false,
        error: { type: 'unsupported_layout' },
        totalCount: 12
      })
      expect(fetchAllItems).not.toHaveBeenCalled()
      expect(fetchItemsCountOnly).toHaveBeenCalledWith({ ...args, query: '' })
    }
  )
})
