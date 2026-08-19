import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { LinearResolvedProject } from './project-target-resolution'

const rawRequest = vi.fn()
const getClients = vi.fn()
const getStatus = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: () => getStatus(),
  isAuthError: vi.fn().mockReturnValue(false)
}))

function entry(): LinearClientForWorkspace {
  return {
    workspace: {
      id: 'workspace-acme',
      organizationId: 'workspace-acme',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    apiKey: 'key',
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

const resolved: LinearResolvedProject = {
  id: 'project-1',
  name: 'Launch',
  slugId: 'launch-abc',
  url: 'https://linear.app/acme/project/launch-abc',
  workspaceId: 'workspace-acme',
  workspaceName: 'Acme',
  resolvedBy: 'slug'
}

function connection(nodes: unknown[], pageInfo?: { hasNextPage: boolean; endCursor?: string }) {
  return { nodes, pageInfo: pageInfo ?? { hasNextPage: false, endCursor: null } }
}

function showResponse(overrides: Record<string, unknown> = {}): unknown {
  return {
    data: {
      project: {
        id: 'project-1',
        name: 'Launch',
        slugId: 'launch-abc',
        url: 'https://linear.app/acme/project/launch-abc',
        description: 'Short\r\nsummary',
        content: null,
        color: '#112233',
        icon: null,
        priority: 0,
        startDate: '2026-01-01',
        targetDate: null,
        health: 'atRisk',
        healthUpdatedAt: '2026-02-02T00:00:00.000Z',
        status: { id: 'status-1', name: 'In progress', type: 'started', color: '#00ff00' },
        lead: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
        members: connection([{ id: 'user-1', displayName: 'Ada', avatarUrl: null }]),
        teams: connection([{ id: 'team-1', name: 'Core', key: 'CORE' }]),
        labels: connection([
          { id: 'label-1', name: 'Infra', color: '#abcdef', isGroup: false, parent: null }
        ]),
        ...overrides
      }
    }
  }
}

async function show(options?: { updates?: boolean; updatesLimit?: number }) {
  const { getProjectShowForAgent } = await import('./project-agent-read')
  return await getProjectShowForAgent(resolved, {
    updates: options?.updates === true,
    updatesLimit: options?.updatesLimit ?? 5
  })
}

describe('Linear project show for agents', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockReturnValue({
      workspaces: [
        { id: 'workspace-acme', organizationId: 'workspace-acme', organizationName: 'Acme' }
      ]
    })
    getClients.mockReturnValue([entry()])
  })

  it('reads the default document without any update selection', async () => {
    rawRequest.mockResolvedValueOnce(showResponse())

    const result = await show()

    const document = rawRequest.mock.calls[0][0] as string
    expect(document).not.toContain('projectUpdates')
    expect(document).not.toContain('body')
    expect(document).toContain('healthUpdatedAt')
    expect(rawRequest.mock.calls[0][1]).toEqual({ id: 'project-1' })
    expect(result.updates).toBeUndefined()
    expect(result.meta).toEqual({
      workspaceId: 'workspace-acme',
      workspaceName: 'Acme',
      resolvedBy: 'slug'
    })
  })

  it('projects every editable field with digests over the complete text', async () => {
    rawRequest.mockResolvedValueOnce(showResponse())

    const result = await show()

    expect(result.project.description).toEqual({
      value: 'Short\nsummary',
      truncated: false,
      chars: 13,
      sha256: createHash('sha256').update('Short\nsummary', 'utf8').digest('hex')
    })
    expect(result.project.content).toEqual({
      value: null,
      truncated: false,
      chars: 0,
      sha256: ''
    })
    expect(result.project).toMatchObject({
      priority: 0,
      startDate: '2026-01-01',
      targetDate: null,
      color: '#112233',
      icon: null,
      health: 'atRisk',
      healthUpdatedAt: '2026-02-02T00:00:00.000Z',
      status: { id: 'status-1', name: 'In progress', type: 'started', color: '#00ff00' },
      lead: { id: 'user-1', displayName: 'Ada', avatarUrl: null }
    })
    expect(result.project.labels.items).toEqual([
      { id: 'label-1', name: 'Infra', color: '#abcdef', parent: null }
    ])
  })

  it('distinguishes empty content from absent content', async () => {
    rawRequest.mockResolvedValueOnce(showResponse({ content: '' }))

    const result = await show()

    expect(result.project.content.value).toBe('')
    expect(result.project.content.sha256).toBe(
      createHash('sha256').update('', 'utf8').digest('hex')
    )
  })

  it('pages members, teams and labels so digests cover every id', async () => {
    rawRequest
      .mockResolvedValueOnce(
        showResponse({
          members: connection([{ id: 'user-1', displayName: 'Ada', avatarUrl: null }], {
            hasNextPage: true,
            endCursor: 'cursor-1'
          })
        })
      )
      .mockResolvedValueOnce({
        data: {
          project: {
            members: connection([{ id: 'user-2', displayName: 'Grace', avatarUrl: null }], {
              hasNextPage: false
            })
          }
        }
      })

    const result = await show()

    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(rawRequest.mock.calls[1][1]).toEqual({ id: 'project-1', first: 50, after: 'cursor-1' })
    expect(result.project.members.items.map((member) => member.id)).toEqual(['user-1', 'user-2'])
    expect(result.project.members).toMatchObject({ returned: 2, total: 2, truncated: false })
    expect(result.project.members.sha256).toBe(
      createHash('sha256')
        .update(JSON.stringify(['user-1', 'user-2']), 'utf8')
        .digest('hex')
    )
  })

  it('caps published items after computing totals and digests', async () => {
    const members = Array.from({ length: 205 }, (_, index) => ({
      id: `user-${String(index).padStart(3, '0')}`,
      displayName: `User ${index}`,
      avatarUrl: null
    }))
    rawRequest.mockResolvedValueOnce(showResponse({ members: connection(members) }))

    const result = await show()

    expect(result.project.members).toMatchObject({ returned: 200, total: 205, truncated: true })
    expect(result.project.members.sha256).toBe(
      createHash('sha256')
        .update(JSON.stringify(members.map((member) => member.id)), 'utf8')
        .digest('hex')
    )
  })

  it('selects the update feed only when updates are requested and sorts newest first', async () => {
    rawRequest.mockResolvedValueOnce(
      showResponse({
        projectUpdates: connection(
          [
            {
              id: 'update-old',
              body: 'Older\r\nbody',
              health: 'onTrack',
              url: 'https://linear.app/acme/project/launch-abc/updates/1',
              isDiffHidden: false,
              isStale: true,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              editedAt: null,
              user: { id: 'user-1', displayName: 'Ada', avatarUrl: null }
            },
            {
              id: 'update-new',
              body: 'Newer',
              health: 'offTrack',
              url: 'https://linear.app/acme/project/launch-abc/updates/2',
              isDiffHidden: true,
              isStale: false,
              createdAt: '2026-03-01T00:00:00.000Z',
              updatedAt: '2026-03-02T00:00:00.000Z',
              editedAt: '2026-03-02T00:00:00.000Z',
              user: { id: 'user-2', displayName: 'Grace', avatarUrl: null }
            }
          ],
          { hasNextPage: true }
        )
      })
    )

    const result = await show({ updates: true, updatesLimit: 2 })

    const document = rawRequest.mock.calls[0][0] as string
    expect(document).toContain('projectUpdates(first: $updatesLimit, orderBy: createdAt)')
    expect(document).not.toContain('filter:')
    expect(rawRequest.mock.calls[0][1]).toEqual({ id: 'project-1', updatesLimit: 2 })
    expect(result.updates?.map((update) => update.id)).toEqual(['update-new', 'update-old'])
    expect(result.updates?.[1].body).toMatchObject({ value: 'Older\nbody', chars: 10 })
    expect(result.meta.updates).toEqual({
      returned: 2,
      cap: 2,
      capReached: true,
      hasMore: true
    })
  })

  it('fails with an invalid-project error when the project disappears', async () => {
    rawRequest.mockResolvedValueOnce({ data: { project: null } })

    await expect(show()).rejects.toMatchObject({ code: 'linear_invalid_project' })
  })
})
