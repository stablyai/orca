import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import { toSshExecutionHostId } from '../../shared/execution-host'

const { ipcHandlers, listWorkItemsMock, getWorkItemByProjectRefMock } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  listWorkItemsMock: vi.fn(),
  getWorkItemByProjectRefMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('../gitlab/client', () => ({
  addIssueComment: vi.fn(),
  addMRInlineComment: vi.fn(),
  addMRComment: vi.fn(),
  closeMR: vi.fn(),
  createIssue: vi.fn(),
  diagnoseAuth: vi.fn(),
  getAuthenticatedViewer: vi.fn(),
  getJobTrace: vi.fn(),
  getIssue: vi.fn(),
  getMergeRequest: vi.fn(),
  getMergeRequestForBranch: vi.fn(),
  getProjectSlug: vi.fn(),
  getRateLimit: vi.fn(),
  getWorkItemByProjectRef: getWorkItemByProjectRefMock,
  listAssignableUsers: vi.fn(),
  listIssues: vi.fn(),
  listLabels: vi.fn(),
  listMergeRequests: vi.fn(),
  listTodos: vi.fn(),
  listWorkItems: listWorkItemsMock,
  mergeMR: vi.fn(),
  reopenMR: vi.fn(),
  resolveMRDiscussion: vi.fn(),
  retryJob: vi.fn(),
  updateIssue: vi.fn(),
  updateMR: vi.fn(),
  updateMRReviewers: vi.fn()
}))

vi.mock('../gitlab/work-item-details', () => ({
  getWorkItemDetails: vi.fn()
}))

vi.mock('../gitlab/gitlab-project-recents', () => ({
  recordGitLabProjectRecent: vi.fn()
}))

import { registerGitLabHandlers } from './gitlab'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-local',
    path: '/local/orca',
    displayName: 'Orca',
    badgeColor: '#737373',
    addedAt: 1,
    ...overrides
  }
}

function storeWithRepos(repos: Repo[]): Pick<Store, 'getRepos' | 'getRepo'> {
  return {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((candidate) => candidate.id === id)
  }
}

describe('GitLab IPC handlers', () => {
  it('resolves repoId and source host context before listing work items', async () => {
    const remoteRepo = repo({
      id: 'repo-ssh',
      path: '/ssh/orca',
      connectionId: 'builder',
      executionHostId: toSshExecutionHostId('builder')
    })
    listWorkItemsMock.mockResolvedValueOnce({ items: [] })
    registerGitLabHandlers(storeWithRepos([repo(), remoteRepo]) as Store)

    const handler = ipcHandlers.get('gitlab:listWorkItems')
    await expect(
      handler?.(null, {
        repoPath: '/does/not/matter',
        repoId: 'repo-ssh',
        sourceContext: {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'gitlab:stablyai/orca',
          hostId: toSshExecutionHostId('builder'),
          repoId: 'repo-ssh'
        }
      })
    ).resolves.toEqual({ items: [] })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/ssh/orca',
      'opened',
      1,
      20,
      undefined,
      undefined,
      'builder'
    )
  })

  it('rejects source context for a different host', async () => {
    registerGitLabHandlers(
      storeWithRepos([repo({ id: 'repo-local', path: '/local/orca' })]) as Store
    )

    const handler = ipcHandlers.get('gitlab:listWorkItems')
    await expect(
      handler?.(null, {
        repoPath: '/local/orca',
        repoId: 'repo-local',
        sourceContext: {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'gitlab:stablyai/orca',
          hostId: toSshExecutionHostId('builder'),
          repoId: 'repo-local'
        }
      })
    ).rejects.toThrow('source host does not match')
  })

  it('resolves pasted URL lookups by repoId and source host context', async () => {
    const remoteRepo = repo({
      id: 'repo-ssh',
      path: '/ssh/orca',
      connectionId: 'builder',
      executionHostId: toSshExecutionHostId('builder')
    })
    getWorkItemByProjectRefMock.mockResolvedValueOnce({
      type: 'issue',
      number: 42,
      title: 'Remote issue'
    })
    registerGitLabHandlers(storeWithRepos([repo(), remoteRepo]) as Store)

    const handler = ipcHandlers.get('gitlab:workItemByPath')
    await expect(
      handler?.(null, {
        repoPath: '/local/orca',
        repoId: 'repo-ssh',
        sourceContext: {
          kind: 'task-source',
          provider: 'gitlab',
          projectId: 'gitlab:stablyai/orca',
          hostId: toSshExecutionHostId('builder'),
          repoId: 'repo-ssh'
        },
        host: 'gitlab.com',
        path: 'stablyai/orca',
        iid: 42,
        type: 'issue'
      })
    ).resolves.toMatchObject({ number: 42 })

    expect(getWorkItemByProjectRefMock).toHaveBeenCalledWith(
      '/ssh/orca',
      { host: 'gitlab.com', path: 'stablyai/orca' },
      42,
      'issue',
      'builder'
    )
  })
})
