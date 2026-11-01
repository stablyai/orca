import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaJsonWithHeadersMock, resolveGiteaIssueSourceMock } = vi.hoisted(() => ({
  requestGiteaJsonWithHeadersMock: vi.fn(),
  resolveGiteaIssueSourceMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJsonWithHeaders: requestGiteaJsonWithHeadersMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

import {
  _resetGiteaLabelCache,
  cachedGiteaLabelId,
  listGiteaAssignableUsers,
  listGiteaLabels
} from './repo-label-and-assignee-lookup'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

function users(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => {
    const id = offset + index + 1
    return {
      id,
      login: `user-${id}`,
      full_name: `User ${id}`,
      avatar_url: `https://example.com/${id}.png`
    }
  })
}

describe('repository labels and assignable users', () => {
  beforeEach(() => {
    requestGiteaJsonWithHeadersMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    _resetGiteaLabelCache()
  })

  it('returns label names and caches id mappings', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [
        { id: 3, name: 'bug' },
        { id: 9, name: 'org-wide' },
        { id: 3, name: 'bug' }
      ],
      headers: { 'x-total-count': '2' }
    })

    await expect(listGiteaLabels('/repo', 'origin', 'conn-1', {})).resolves.toEqual([
      'bug',
      'org-wide'
    ])
    expect(cachedGiteaLabelId(repo, 'bug')).toBe(3)
    expect(cachedGiteaLabelId(repo, 'org-wide')).toBe(9)
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledTimes(1)
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/labels',
      { searchParams: { page: 1, limit: 50 } }
    )
  })

  it('paginates assignable users and stops after a short page', async () => {
    requestGiteaJsonWithHeadersMock.mockImplementation(
      async (_repo: unknown, path: string, options?: { searchParams?: { page?: number } }) => {
        if (path !== '/repos/team/widgets/assignees') {
          throw new Error(`unexpected Gitea path: ${path}`)
        }
        const page = options?.searchParams?.page ?? 1
        return {
          data: page === 1 ? users(50) : users(1, 50),
          headers: {}
        }
      }
    )

    const assignees = await listGiteaAssignableUsers('/repo')

    expect(assignees).toHaveLength(51)
    expect(assignees[0]).toEqual({
      id: 1,
      username: 'user-1',
      name: 'User 1',
      avatarUrl: 'https://example.com/1.png'
    })
    expect(assignees[50]).toEqual({
      id: 51,
      username: 'user-51',
      name: 'User 51',
      avatarUrl: 'https://example.com/51.png'
    })
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledTimes(2)
  })

  it('returns empty lists when the repository cannot be resolved', async () => {
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: null, fellBack: false })

    await expect(listGiteaLabels('/repo')).resolves.toEqual([])
    await expect(listGiteaAssignableUsers('/repo')).resolves.toEqual([])
    expect(requestGiteaJsonWithHeadersMock).not.toHaveBeenCalled()
  })
})
