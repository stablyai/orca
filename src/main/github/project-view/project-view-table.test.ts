import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fetchFieldsContinuation,
  fetchProjectViewsPage,
  type RawProjectView
} from './project-view-config'
import type * as ProjectViewConfig from './project-view-config'
import { fetchAllItems, fetchItemsCountOnly } from './project-view-items'
import { getProjectViewTable } from './project-view-table'

vi.mock('./project-view-config', async (importOriginal) => ({
  ...(await importOriginal<typeof ProjectViewConfig>()),
  fetchProjectViewsPage: vi.fn(),
  fetchFieldsContinuation: vi.fn()
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
    projectFields: [],
    projectFieldsEndCursor: null,
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
  it('passes project-level fields through so the View menu can offer hidden fields', async () => {
    const sprint = {
      kind: 'iteration' as const,
      id: 'f_sprint',
      name: 'Sprint',
      dataType: 'ITERATION' as const,
      iterations: []
    }
    vi.mocked(fetchProjectViewsPage).mockResolvedValue({
      ...page([view('board', 'BOARD_LAYOUT')]),
      projectFields: [sprint]
    })
    const result = await getProjectViewTable({ ...args, viewId: 'board' })
    expect(result).toMatchObject({ ok: true, data: { projectFields: [sprint] } })
    expect(fetchProjectViewsPage).toHaveBeenCalledWith({
      ...args,
      after: null,
      includeProjectFields: true
    })
  })

  it('follows project fields past the first page, keeping that page if a later one fails', async () => {
    const field = (id: string) => ({
      __typename: 'ProjectV2Field',
      id,
      name: id,
      dataType: 'TEXT'
    })
    vi.mocked(fetchProjectViewsPage).mockResolvedValue({
      ...page([view('board', 'BOARD_LAYOUT')]),
      projectFields: [{ kind: 'field', id: 'f_1', name: 'f_1', dataType: 'TEXT' }],
      projectFieldsEndCursor: 'fields-next'
    })
    vi.mocked(fetchFieldsContinuation).mockResolvedValueOnce({ ok: true, fields: [field('f_51')] })
    const result = await getProjectViewTable({ ...args, viewId: 'board' })
    expect(fetchFieldsContinuation).toHaveBeenCalledWith('project', 'fields-next', args.host)
    expect(result).toMatchObject({
      ok: true,
      data: { projectFields: [{ id: 'f_1' }, { id: 'f_51' }] }
    })

    vi.mocked(fetchFieldsContinuation).mockResolvedValueOnce({
      ok: false,
      error: { type: 'unknown', message: 'boom' }
    })
    const degraded = await getProjectViewTable({ ...args, viewId: 'board' })
    expect(degraded).toMatchObject({ ok: true, data: { projectFields: [{ id: 'f_1' }] } })
  })

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
})
