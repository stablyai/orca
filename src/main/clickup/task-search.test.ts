import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClickUpClientForWorkspace } from './client'

const { clickUpRequestMock, getClientsMock, getStatusMock } = vi.hoisted(() => ({
  clickUpRequestMock: vi.fn(),
  getClientsMock: vi.fn(),
  getStatusMock: vi.fn()
}))

vi.mock('./client', () => ({
  ClickUpApiError: class ClickUpApiError extends Error {
    status: number | null
    constructor(message: string, status: number | null = null) {
      super(message)
      this.status = status
    }
  },
  clickUpRequest: (...args: unknown[]) => clickUpRequestMock(...args),
  getStatus: (...args: unknown[]) => getStatusMock(...args),
  onClickUpDisconnect: vi.fn(),
  requireClickUpClient: (workspaceId?: string) => getClientsMock(workspaceId)[0],
  requireClickUpClients: (workspaceId?: string) => getClientsMock(workspaceId)
}))

function client(id = 'team-1'): ClickUpClientForWorkspace {
  return { workspace: { id, name: `Workspace ${id}` }, token: 'pk_token' }
}

function rawTask(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    custom_id: null,
    name,
    url: `https://app.clickup.com/t/${id}`,
    status: { status: 'open', type: 'open' },
    list: { id: 'list-1', name: 'Backlog' },
    date_created: '1767225600000',
    date_updated: '1767312000000',
    ...overrides
  }
}

function fullPage(prefix: string) {
  return Array.from({ length: 100 }, (_, index) =>
    rawTask(`${prefix}${index}`, `Unrelated ${prefix} ${index}`)
  )
}

function pathOf(callIndex: number): string {
  return String(clickUpRequestMock.mock.calls[callIndex]?.[1])
}

type Pages = Record<'assigned' | 'open' | 'all', unknown[][]>

// Routes /team/{id}/task requests by scope and page number.
function mockPages(pages: Partial<Pages>): void {
  clickUpRequestMock.mockImplementation(async (_client: unknown, path: string) => {
    const url = new URL(`https://x${path}`)
    const page = Number(url.searchParams.get('page'))
    const scope = url.searchParams.has('assignees[]')
      ? 'assigned'
      : url.searchParams.get('include_closed') === 'true'
        ? 'all'
        : 'open'
    return { tasks: pages[scope]?.[page] ?? [] }
  })
}

describe('rankClickUpTaskMatch', () => {
  it('ranks exact ids, then name prefixes, then substrings, case-insensitively', async () => {
    const { rankClickUpTaskMatch } = await import('./task-search')
    const task = {
      id: '86bcbcknf',
      customId: 'CHP-7375',
      name: 'Honeywell Accounts – Mandatory Global Notes'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ranking reads only id, customId, and name.
    const match = (query: string) => rankClickUpTaskMatch(task as never, query)

    expect(match('chp-7375')).toBe(0)
    expect(match('86BCBCKNF')).toBe(0)
    expect(match('honeywell')).toBe(1)
    expect(match('GLOBAL notes')).toBe(2)
    expect(match('chp-73')).toBe(3)
    expect(match('honeywell mandatory')).toBe(4)
    expect(match('zebra')).toBeNull()
  })
})

describe('searchClickUpTasks', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    getClientsMock.mockReturnValue([client()])
    getStatusMock.mockReturnValue({ connected: true, viewer: { id: 7, username: 'Ada' } })
    const { clearClickUpSearchCacheForTests } = await import('./task-search')
    clearClickUpSearchCacheForTests()
  })

  it("finds a name match in the viewer's assigned tasks with one request", async () => {
    mockPages({ assigned: [[rawTask('h1', 'Honeywell Accounts – QC Notes')]] })
    const { searchClickUpTasks } = await import('./task-search')

    await expect(searchClickUpTasks('honeywell', 1, 'team-1')).resolves.toMatchObject([
      { id: 'h1' }
    ])
    expect(clickUpRequestMock).toHaveBeenCalledTimes(1)
    expect(pathOf(0)).toContain('assignees%5B%5D=7')
  })

  it('pages past the old 10-page window until it finds a match', async () => {
    const openPages = Array.from({ length: 10 }, (_, page) => fullPage(`p${page}-`))
    openPages.push([rawTask('deep', 'Honeywell migration')])
    mockPages({ assigned: [[]], open: openPages })
    const { searchClickUpTasks } = await import('./task-search')

    await expect(searchClickUpTasks('Honeywell', 5, 'team-1')).resolves.toMatchObject([
      { id: 'deep' }
    ])
    // Page 0 alone, then batches of 3: the batch holding page 10 reads pages 10-12.
    const openRequests = clickUpRequestMock.mock.calls.filter((call) =>
      String(call[1]).includes('include_closed=false')
    )
    expect(openRequests.length).toBe(12)
  })

  it('stops at the page cap instead of walking an unbounded Workspace', async () => {
    mockPages({
      assigned: [[]],
      open: Array.from({ length: 100 }, (_, page) => fullPage(`o${page}-`)),
      all: Array.from({ length: 100 }, (_, page) => fullPage(`a${page}-`))
    })
    const { searchClickUpTasks } = await import('./task-search')

    await expect(searchClickUpTasks('nothing-matches-this', 5, 'team-1')).resolves.toEqual([])
    // 1 assigned + 12 open + 5 all-including-closed pages.
    expect(clickUpRequestMock).toHaveBeenCalledTimes(18)
  })

  it('reuses cached pages while the query is refined', async () => {
    mockPages({ assigned: [[rawTask('h1', 'Honeywell Accounts')]], open: [[]], all: [[]] })
    const { searchClickUpTasks } = await import('./task-search')

    await searchClickUpTasks('hon', 5, 'team-1')
    const firstCount = clickUpRequestMock.mock.calls.length
    await searchClickUpTasks('honey', 5, 'team-1')

    expect(clickUpRequestMock).toHaveBeenCalledTimes(firstCount)
  })

  it('resolves a custom task id directly without paging', async () => {
    clickUpRequestMock.mockResolvedValue(rawTask('abc', 'Anything', { custom_id: 'CHP-7616' }))
    const { searchClickUpTasks } = await import('./task-search')

    await expect(searchClickUpTasks('chp-7616', 5, 'team-1')).resolves.toMatchObject([
      { id: 'abc', customId: 'CHP-7616' }
    ])
    expect(clickUpRequestMock).toHaveBeenCalledTimes(1)
    expect(pathOf(0)).toContain('/task/CHP-7616?')
    expect(pathOf(0)).toContain('custom_task_ids=true&team_id=team-1')
  })

  it('resolves a pasted ClickUp task URL directly', async () => {
    clickUpRequestMock.mockResolvedValue(rawTask('86bcbcknf', 'Honeywell'))
    const { searchClickUpTasks } = await import('./task-search')

    await expect(
      searchClickUpTasks('https://app.clickup.com/t/86bcbcknf', 5, 'team-1')
    ).resolves.toMatchObject([{ id: '86bcbcknf' }])
    expect(pathOf(0)).toMatch(/^\/task\/86bcbcknf\?/)
  })

  it('falls back to paging when an id-shaped query is not a task', async () => {
    const { ClickUpApiError } = await import('./client')
    mockPages({ assigned: [[rawTask('x', 'Fix abc123 parser')]] })
    const pagesImpl = clickUpRequestMock.getMockImplementation()
    clickUpRequestMock.mockImplementationOnce(async () => {
      throw new ClickUpApiError('Task not found', 404)
    })
    clickUpRequestMock.mockImplementation(pagesImpl!)
    const { searchClickUpTasks } = await import('./task-search')

    await expect(searchClickUpTasks('abc123', 1, 'team-1')).resolves.toMatchObject([{ id: 'x' }])
  })

  it('stops paging an older query once a newer one starts', async () => {
    let releaseFirst: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    clickUpRequestMock.mockImplementation(async (_client: unknown, path: string) => {
      if (path.includes('assignees')) {
        await gate
        return { tasks: [] }
      }
      return { tasks: fullPage(path.length.toString()) }
    })
    const { searchClickUpTasks } = await import('./task-search')

    const older = searchClickUpTasks('first', 5, 'team-1')
    const olderResult = expect(older).rejects.toThrow('newer ClickUp search')
    const newer = searchClickUpTasks('second', 5, 'team-1')
    releaseFirst()
    await olderResult
    await newer
    const openCallsForOlder = clickUpRequestMock.mock.calls.length
    // The newer search walks its own caps; the older one issued no open pages.
    expect(openCallsForOlder).toBe(18)
  })
})
