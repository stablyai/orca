import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()
const acquire = vi.fn().mockResolvedValue(undefined)
const release = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: (...args: unknown[]) => acquire(...args),
  release: (...args: unknown[]) => release(...args)
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  createSignalBoundLinearClient: (entry: LinearClientForWorkspace) => entry.client,
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
}))

function makeEntry(): LinearClientForWorkspace {
  return {
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function rawProject(id: string) {
  return { id, name: id, url: `https://linear.app/project/${id}`, teams: { nodes: [] } }
}

function projectPage(
  ids: string[],
  pageInfo: { hasNextPage: boolean; endCursor?: string | null } = { hasNextPage: false }
) {
  return { data: { projects: { nodes: ids.map(rawProject), pageInfo } } }
}

describe('Linear project list read deadline', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    acquire.mockResolvedValue(undefined)
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([makeEntry()])
  })

  // Deadline not reached: the walk runs to provider exhaustion and reports a complete read.
  it('completes an unbounded walk and reports no truncation when the deadline is not reached', async () => {
    rawRequest.mockImplementation((_query, variables: Record<string, unknown>) =>
      Promise.resolve(
        variables.after
          ? projectPage(['project-51'], { hasNextPage: false })
          : projectPage(
              Array.from({ length: 50 }, (_, index) => `project-${index + 1}`),
              { hasNextPage: true, endCursor: 'cursor-50' }
            )
      )
    )
    const { listProjects } = await import('./linear-project-queries')

    const result = await listProjects(undefined, null, 'workspace-1', true)

    expect(result.items).toHaveLength(51)
    expect(result.hasMore).toBe(false)
    expect(rawRequest).toHaveBeenCalledTimes(2)
  })

  // A genuinely empty workspace is the control for the zero-result deadline case below.
  it('reports an empty provider result as complete, not truncated', async () => {
    rawRequest.mockResolvedValue(projectPage([], { hasNextPage: false }))
    const { listProjects } = await import('./linear-project-queries')

    const result = await listProjects(undefined, null, 'workspace-1', true)

    expect(result).toMatchObject({ items: [], hasMore: false })
    expect(result.errors ?? []).toEqual([])
  })

  it('keeps the rows it already read and reports truncation when the deadline lands mid-walk', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    rawRequest.mockImplementation(() =>
      Promise.resolve(
        projectPage(
          Array.from({ length: 50 }, (_, index) => `project-${index + 1}`),
          { hasNextPage: true, endCursor: `cursor-${Date.now()}` }
        )
      )
    )
    const { listProjects } = await import('./linear-project-queries')

    const pending = listProjects(undefined, null, 'workspace-1', true)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending

    expect(result.items).toHaveLength(50)
    expect(result.hasMore).toBe(true)
    expect(result.errors ?? []).toEqual([])
    vi.useRealTimers()
  })

  // Why: the page ceiling is the backstop the deadline cannot cover — a provider that keeps
  // handing out fresh cursors inside the budget would otherwise walk forever.
  it('stops an unbounded walk at the page ceiling and still reports truncation', async () => {
    let page = 0
    rawRequest.mockImplementation(() => {
      page += 1
      return Promise.resolve(
        projectPage([`project-${page}`], { hasNextPage: true, endCursor: `cursor-${page}` })
      )
    })
    const { listProjects } = await import('./linear-project-queries')

    const result = await listProjects(undefined, null, 'workspace-1', true)

    expect(result.items).toHaveLength(200)
    expect(result.hasMore).toBe(true)
    expect(rawRequest).toHaveBeenCalledTimes(200)
  })

  // Why: an exhausted deadline that returned nothing must not be reported as an empty workspace.
  it('distinguishes a zero-result deadline exhaustion from an empty result', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    let grantPermit!: () => void
    acquire.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        grantPermit = resolve
      })
    )
    const { listProjects } = await import('./linear-project-queries')

    const pending = listProjects(undefined, null, 'workspace-1', true)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending

    expect(result).toMatchObject({ items: [], hasMore: true })
    expect(result.errors ?? []).toEqual([])
    expect(rawRequest).not.toHaveBeenCalled()
    grantPermit()
    await Promise.resolve()
    expect(release).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
