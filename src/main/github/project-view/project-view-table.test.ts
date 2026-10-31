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
const view = (id: string, layout: string, filter = 'status:open'): RawProjectView => ({
  id,
  number: 1,
  name: id,
  layout,
  filter,
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

  it('fetches board items like a table', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('board', 'BOARD_LAYOUT')]))
    const result = await getProjectViewTable({ ...args, viewId: 'board' })
    expect(result).toMatchObject({ ok: true, data: { selectedView: { layout: 'BOARD_LAYOUT' } } })
    expect(fetchAllItems).toHaveBeenCalledWith({ ...args, query: 'status:open' })
    expect(fetchItemsCountOnly).not.toHaveBeenCalled()
  })

  it('defaults to a board when neither a table nor a roadmap exists', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('board', 'BOARD_LAYOUT')]))
    expect(await getProjectViewTable(args)).toMatchObject({
      ok: true,
      data: { selectedView: { id: 'board' } }
    })
  })

  it('rejects an unknown future layout without fetching items', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('unsupported', 'FUTURE_LAYOUT')]))
    expect(
      await getProjectViewTable({ ...args, viewId: 'unsupported', queryOverride: '' })
    ).toMatchObject({
      ok: false,
      error: { type: 'unsupported_layout' },
      totalCount: 12
    })
    expect(fetchAllItems).not.toHaveBeenCalled()
    expect(fetchItemsCountOnly).toHaveBeenCalledWith({ ...args, query: '' })
  })

  it('falls back to an omitted query for unfiltered views when the index returns 0 items (#12648)', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('table', 'TABLE_LAYOUT', '')]))
    const rows = [{ id: 'issue-1' }] as any
    vi.mocked(fetchAllItems)
      .mockResolvedValueOnce({ ok: true, rows: [], totalCount: 0, parentFieldDropped: false })
      .mockResolvedValueOnce({ ok: true, rows, totalCount: 1, parentFieldDropped: false })
    const result = await getProjectViewTable({ ...args, viewId: 'table' })
    expect(result).toMatchObject({ ok: true, data: { rows, totalCount: 1 } })
    expect(fetchAllItems).toHaveBeenCalledTimes(2)
    expect(fetchAllItems).toHaveBeenNthCalledWith(1, { ...args, query: '' })
    expect(fetchAllItems).toHaveBeenNthCalledWith(2, { ...args, query: null })
  })

  it('does not fall back for filtered views with zero matches', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(
      page([view('table', 'TABLE_LAYOUT', 'status:open')])
    )
    const result = await getProjectViewTable({ ...args, viewId: 'table' })
    expect(result).toMatchObject({ ok: true, data: { rows: [], totalCount: 0 } })
    expect(fetchAllItems).toHaveBeenCalledTimes(1)
    expect(fetchAllItems).toHaveBeenCalledWith({ ...args, query: 'status:open' })
  })

  it('surfaces fallback errors instead of a false empty state', async () => {
    vi.mocked(fetchProjectViewsPage).mockResolvedValue(page([view('table', 'TABLE_LAYOUT', '')]))
    vi.mocked(fetchAllItems)
      .mockResolvedValueOnce({ ok: true, rows: [], totalCount: 0, parentFieldDropped: false })
      .mockResolvedValueOnce({
        ok: false,
        error: { type: 'too_large', message: 'View has 501 items.' },
        totalCount: 501
      })
    const result = await getProjectViewTable({ ...args, viewId: 'table' })
    expect(result).toMatchObject({ ok: false, error: { type: 'too_large' }, totalCount: 501 })
  })
})
