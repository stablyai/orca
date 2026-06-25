import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { Repo } from '../../shared/types'
import { toSshExecutionHostId } from '../../shared/execution-host'

const ORIGINAL_PLATFORM = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform
  })
}

const {
  ipcHandlers,
  listMergeRequestsMock,
  getIssueMock,
  listIssuesMock,
  createIssueMock,
  updateIssueMock,
  addIssueCommentMock,
  closeMRMock,
  reopenMRMock,
  mergeMRMock,
  updateMRMock,
  updateMRReviewersMock,
  addMRCommentMock,
  addMRInlineCommentMock,
  resolveMRDiscussionMock,
  getJobTraceMock,
  retryJobMock,
  listLabelsMock,
  listAssignableUsersMock,
  listTodosMock,
  listWorkItemsMock,
  getWorkItemDetailsMock,
  getWorkItemByProjectRefMock,
  getMergeRequestMock,
  getMergeRequestForBranchMock,
  getProjectSlugMock
} = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  listMergeRequestsMock: vi.fn(),
  getIssueMock: vi.fn(),
  listIssuesMock: vi.fn(),
  createIssueMock: vi.fn(),
  updateIssueMock: vi.fn(),
  addIssueCommentMock: vi.fn(),
  closeMRMock: vi.fn(),
  reopenMRMock: vi.fn(),
  mergeMRMock: vi.fn(),
  updateMRMock: vi.fn(),
  updateMRReviewersMock: vi.fn(),
  addMRCommentMock: vi.fn(),
  addMRInlineCommentMock: vi.fn(),
  resolveMRDiscussionMock: vi.fn(),
  getJobTraceMock: vi.fn(),
  retryJobMock: vi.fn(),
  listLabelsMock: vi.fn(),
  listAssignableUsersMock: vi.fn(),
  listTodosMock: vi.fn(),
  listWorkItemsMock: vi.fn(),
  getWorkItemDetailsMock: vi.fn(),
  getWorkItemByProjectRefMock: vi.fn(),
  getMergeRequestMock: vi.fn(),
  getMergeRequestForBranchMock: vi.fn(),
  getProjectSlugMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))

vi.mock('../gitlab/client', () => ({
  addIssueComment: addIssueCommentMock,
  addMRInlineComment: addMRInlineCommentMock,
  addMRComment: addMRCommentMock,
  closeMR: closeMRMock,
  createIssue: createIssueMock,
  diagnoseAuth: vi.fn(),
  getAuthenticatedViewer: vi.fn(),
  getJobTrace: getJobTraceMock,
  getIssue: getIssueMock,
  getMergeRequest: getMergeRequestMock,
  getMergeRequestForBranch: getMergeRequestForBranchMock,
  getProjectSlug: getProjectSlugMock,
  getRateLimit: vi.fn(),
  getWorkItemByProjectRef: getWorkItemByProjectRefMock,
  listAssignableUsers: listAssignableUsersMock,
  listIssues: listIssuesMock,
  listLabels: listLabelsMock,
  listMergeRequests: listMergeRequestsMock,
  listTodos: listTodosMock,
  listWorkItems: listWorkItemsMock,
  mergeMR: mergeMRMock,
  reopenMR: reopenMRMock,
  resolveMRDiscussion: resolveMRDiscussionMock,
  retryJob: retryJobMock,
  updateIssue: updateIssueMock,
  updateMR: updateMRMock,
  updateMRReviewers: updateMRReviewersMock
}))

vi.mock('../gitlab/work-item-details', () => ({
  getWorkItemDetails: getWorkItemDetailsMock
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

function storeWithRepos(
  repos: Repo[],
  projects: ReturnType<Store['getProjects']> = []
): Pick<Store, 'getRepos' | 'getRepo' | 'getProjects' | 'getSettings'> {
  return {
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((candidate) => candidate.id === id),
    getProjects: () => projects,
    getSettings: () =>
      ({
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      }) as ReturnType<Store['getSettings']>
  }
}

describe('GitLab IPC handlers', () => {
  beforeEach(() => {
    setPlatform(ORIGINAL_PLATFORM)
    ipcHandlers.clear()
    for (const mock of [
      listMergeRequestsMock,
      getIssueMock,
      listIssuesMock,
      createIssueMock,
      updateIssueMock,
      addIssueCommentMock,
      closeMRMock,
      reopenMRMock,
      mergeMRMock,
      updateMRMock,
      updateMRReviewersMock,
      addMRCommentMock,
      addMRInlineCommentMock,
      resolveMRDiscussionMock,
      getJobTraceMock,
      retryJobMock,
      listLabelsMock,
      listAssignableUsersMock,
      listTodosMock,
      listWorkItemsMock,
      getWorkItemDetailsMock,
      getWorkItemByProjectRefMock,
      getMergeRequestMock,
      getMergeRequestForBranchMock,
      getProjectSlugMock
    ]) {
      mock.mockReset()
    }
  })

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

  it('routes local WSL project GitLab issue, MR, work-item, and todo IPC through project git options', async () => {
    setPlatform('win32')
    const projects: ReturnType<Store['getProjects']> = [
      {
        id: 'project-1',
        displayName: 'Orca',
        badgeColor: 'blue',
        sourceRepoIds: ['repo-local'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ]
    listMergeRequestsMock.mockResolvedValue({ items: [] })
    listWorkItemsMock.mockResolvedValue({ items: [] })
    listIssuesMock.mockResolvedValue({ items: [] })
    getIssueMock.mockResolvedValue(null)
    createIssueMock.mockResolvedValue({ ok: true, number: 1, url: 'https://gitlab.example/1' })
    updateIssueMock.mockResolvedValue({ ok: true })
    addIssueCommentMock.mockResolvedValue({ ok: true })
    listLabelsMock.mockResolvedValue([])
    listAssignableUsersMock.mockResolvedValue([])
    listTodosMock.mockResolvedValue([])
    getProjectSlugMock.mockResolvedValue({ host: 'gitlab.com', path: 'stablyai/orca' })
    getMergeRequestForBranchMock.mockResolvedValue(null)
    getMergeRequestMock.mockResolvedValue(null)
    registerGitLabHandlers(storeWithRepos([repo()], projects) as Store)
    const localGitOptions = { wslDistro: 'Ubuntu' }

    await ipcHandlers.get('gitlab:projectSlug')?.(null, { repoPath: '/local/orca' })
    await ipcHandlers.get('gitlab:mrForBranch')?.(null, {
      repoPath: '/local/orca',
      branch: 'feature/wsl'
    })
    await ipcHandlers.get('gitlab:mr')?.(null, { repoPath: '/local/orca', iid: 8 })
    await ipcHandlers.get('gitlab:listMRs')?.(null, {
      repoPath: '/local/orca',
      state: 'opened',
      page: 1,
      perPage: 20
    })
    await ipcHandlers.get('gitlab:listWorkItems')?.(null, {
      repoPath: '/local/orca',
      state: 'opened',
      page: 1,
      perPage: 20
    })
    await ipcHandlers.get('gitlab:listIssues')?.(null, {
      repoPath: '/local/orca',
      state: 'opened',
      limit: 20
    })
    await ipcHandlers.get('gitlab:issue')?.(null, { repoPath: '/local/orca', number: 7 })
    await ipcHandlers.get('gitlab:createIssue')?.(null, {
      repoPath: '/local/orca',
      title: 'Title',
      body: 'Body'
    })
    await ipcHandlers.get('gitlab:updateIssue')?.(null, {
      repoPath: '/local/orca',
      number: 7,
      updates: { body: 'Updated' }
    })
    await ipcHandlers.get('gitlab:addIssueComment')?.(null, {
      repoPath: '/local/orca',
      number: 7,
      body: 'Comment'
    })
    await ipcHandlers.get('gitlab:listLabels')?.(null, { repoPath: '/local/orca' })
    await ipcHandlers.get('gitlab:listAssignableUsers')?.(null, { repoPath: '/local/orca' })
    await ipcHandlers.get('gitlab:todos')?.(null, { repoPath: '/local/orca' })

    const hostedReviewOptions = { localGitExecOptions: localGitOptions }
    expect(getProjectSlugMock).toHaveBeenCalledWith('/local/orca', null, hostedReviewOptions)
    expect(getMergeRequestForBranchMock).toHaveBeenCalledWith(
      '/local/orca',
      'feature/wsl',
      null,
      null,
      hostedReviewOptions
    )
    expect(getMergeRequestMock).toHaveBeenCalledWith('/local/orca', 8, null, hostedReviewOptions)
    expect(listMergeRequestsMock).toHaveBeenCalledWith(
      '/local/orca',
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/local/orca',
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listIssuesMock).toHaveBeenCalledWith(
      '/local/orca',
      20,
      undefined,
      'opened',
      undefined,
      null,
      localGitOptions
    )
    expect(getIssueMock).toHaveBeenCalledWith('/local/orca', 7, null, localGitOptions)
    expect(createIssueMock).toHaveBeenCalledWith(
      '/local/orca',
      'Title',
      'Body',
      undefined,
      null,
      localGitOptions
    )
    expect(updateIssueMock).toHaveBeenCalledWith(
      '/local/orca',
      7,
      { body: 'Updated' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addIssueCommentMock).toHaveBeenCalledWith(
      '/local/orca',
      7,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(listLabelsMock).toHaveBeenCalledWith('/local/orca', undefined, null, localGitOptions)
    expect(listAssignableUsersMock).toHaveBeenCalledWith(
      '/local/orca',
      undefined,
      null,
      localGitOptions
    )
    expect(listTodosMock).toHaveBeenCalledWith('/local/orca', null, localGitOptions)
  })

  it('routes local WSL project GitLab MR details, review, job, and pasted URL IPC through project git options', async () => {
    setPlatform('win32')
    const projects: ReturnType<Store['getProjects']> = [
      {
        id: 'project-1',
        displayName: 'Orca',
        badgeColor: 'blue',
        sourceRepoIds: ['repo-local'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
        createdAt: 0,
        updatedAt: 0
      }
    ]
    const inlineInput = {
      body: 'Inline',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    getWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    closeMRMock.mockResolvedValue({ ok: true })
    reopenMRMock.mockResolvedValue({ ok: true })
    mergeMRMock.mockResolvedValue({ ok: true })
    updateMRMock.mockResolvedValue({ ok: true })
    updateMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
    addMRCommentMock.mockResolvedValue({ ok: true })
    addMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveMRDiscussionMock.mockResolvedValue({ ok: true })
    getJobTraceMock.mockResolvedValue({ ok: true, trace: 'trace' })
    retryJobMock.mockResolvedValue({ ok: true })
    getWorkItemByProjectRefMock.mockResolvedValue({ type: 'mr', number: 8 })
    registerGitLabHandlers(storeWithRepos([repo()], projects) as Store)
    const localGitOptions = { wslDistro: 'Ubuntu' }

    await ipcHandlers.get('gitlab:workItemDetails')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      type: 'mr'
    })
    await ipcHandlers.get('gitlab:closeMR')?.(null, { repoPath: '/local/orca', iid: 8 })
    await ipcHandlers.get('gitlab:reopenMR')?.(null, { repoPath: '/local/orca', iid: 8 })
    await ipcHandlers.get('gitlab:mergeMR')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      method: 'squash'
    })
    await ipcHandlers.get('gitlab:updateMR')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      updates: { title: 'Renamed' }
    })
    await ipcHandlers.get('gitlab:updateMRReviewers')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      reviewerIds: [1]
    })
    await ipcHandlers.get('gitlab:addMRComment')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      body: 'Comment'
    })
    await ipcHandlers.get('gitlab:addMRInlineComment')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      input: inlineInput
    })
    await ipcHandlers.get('gitlab:resolveMRDiscussion')?.(null, {
      repoPath: '/local/orca',
      iid: 8,
      discussionId: 'discussion-1',
      resolved: true
    })
    await ipcHandlers.get('gitlab:jobTrace')?.(null, { repoPath: '/local/orca', jobId: 99 })
    await ipcHandlers.get('gitlab:retryJob')?.(null, { repoPath: '/local/orca', jobId: 99 })
    await ipcHandlers.get('gitlab:workItemByPath')?.(null, {
      repoPath: '/local/orca',
      host: 'gitlab.com',
      path: 'g/p',
      iid: 8,
      type: 'mr'
    })

    expect(getWorkItemDetailsMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(closeMRMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(reopenMRMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(mergeMRMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      'squash',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateMRMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      { title: 'Renamed' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateMRReviewersMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      [1],
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addMRCommentMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addMRInlineCommentMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      inlineInput,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(resolveMRDiscussionMock).toHaveBeenCalledWith(
      '/local/orca',
      8,
      'discussion-1',
      true,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getJobTraceMock).toHaveBeenCalledWith(
      '/local/orca',
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(retryJobMock).toHaveBeenCalledWith(
      '/local/orca',
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getWorkItemByProjectRefMock).toHaveBeenCalledWith(
      '/local/orca',
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr',
      null,
      localGitOptions
    )
  })
})
