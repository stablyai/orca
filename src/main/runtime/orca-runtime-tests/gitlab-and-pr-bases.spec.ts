import { describe, expect, it } from 'vitest'
import {
  OrcaRuntimeService,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  closeGitLabMRMock,
  createGitLabIssueMock,
  getGitLabJobTraceMock,
  getGitLabWorkItemByProjectRefMock,
  getGitLabWorkItemDetailsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabMergeRequestsMock,
  listGitLabTodosMock,
  listGitLabWorkItemsMock,
  mergeGitLabMRMock,
  reopenGitLabMRMock,
  resolveGitLabMRDiscussionMock,
  retryGitLabJobMock,
  setPlatform,
  updateGitLabIssueMock,
  updateGitLabMRMock,
  updateGitLabMRReviewersMock
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('passes SSH connection ids through GitLab task operations', async () => {
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({
      items: [
        {
          number: 7,
          title: 'Issue title',
          state: 'opened',
          url: 'https://gitlab.example/issues/7',
          labels: ['bug'],
          updatedAt: '2026-05-22T00:00:00Z',
          author: 'alex'
        }
      ],
      totalPages: 3
    })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue(['bug', 'frontend'])
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({
      id: 'gitlab-issue-7',
      type: 'issue',
      number: 7
    })
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 1,
      url: 'https://gitlab.example/issues/1'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'log' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })

    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'closed', 2, 25, 'ambiguous selector')
    const issues = await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', '@me', 50, 3)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'New issue', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { state: 'closed' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Looks good')
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Ship it')
    const inlineCommentInput = {
      body: 'please fix',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineCommentInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1, 2])
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue'
    )

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      '/remote/repo',
      'closed',
      2,
      25,
      'origin',
      'ambiguous selector',
      'ssh-1'
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      '/remote/repo',
      50,
      'origin',
      'opened',
      '@me',
      'ssh-1',
      {},
      3
    )
    expect(issues.items).toEqual([
      {
        id: `gitlab-issue-${TEST_REPO_ID}-7`,
        type: 'issue',
        number: 7,
        title: 'Issue title',
        state: 'opened',
        url: 'https://gitlab.example/issues/7',
        labels: ['bug'],
        updatedAt: '2026-05-22T00:00:00Z',
        author: 'alex',
        repoId: TEST_REPO_ID
      }
    ])
    expect(issues).toMatchObject({ totalPages: 3 })
    expect(listGitLabTodosMock).toHaveBeenCalledWith('/remote/repo', 'ssh-1')
    expect(listGitLabLabelsMock).toHaveBeenCalledWith('/remote/repo', 'origin', 'ssh-1')
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      'New issue',
      'Body',
      'origin',
      'ssh-1'
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      { state: 'closed' },
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      'Looks good',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'Ship it',
      'origin',
      'ssh-1',
      undefined
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      inlineCommentInput,
      'origin',
      'ssh-1',
      undefined
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'discussion-1',
      true,
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      '/remote/repo',
      99,
      'origin',
      'ssh-1',
      undefined
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'squash',
      'origin',
      'ssh-1',
      undefined
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(reopenGitLabMRMock).toHaveBeenCalledWith('/remote/repo', 8, 'origin', 'ssh-1', undefined)
    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      'mr',
      'origin',
      'ssh-1',
      undefined
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      [1, 2],
      'origin',
      'ssh-1',
      undefined
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      '/remote/repo',
      { host: 'gitlab.example.com', path: 'group/project' },
      7,
      'issue',
      'ssh-1'
    )
  })

  it('routes runtime GitLab issue, MR, work-item, and todo actions through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }
    listGitLabMergeRequestsMock.mockResolvedValue({ items: [] })
    listGitLabWorkItemsMock.mockResolvedValue({ items: [] })
    listGitLabIssuesMock.mockResolvedValue({ items: [] })
    listGitLabTodosMock.mockResolvedValue([])
    listGitLabLabelsMock.mockResolvedValue([])
    createGitLabIssueMock.mockResolvedValue({
      ok: true,
      number: 7,
      url: 'https://gitlab.example/issues/7'
    })
    updateGitLabIssueMock.mockResolvedValue({ ok: true })
    addGitLabIssueCommentMock.mockResolvedValue({ ok: true })

    await runtime.listGitLabRepoMRs(TEST_REPO_ID, 'opened', 1, 20)
    await runtime.listGitLabRepoWorkItems(TEST_REPO_ID, 'opened', 1, 20)
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'opened', undefined, 20)
    await runtime.listGitLabRepoTodos(TEST_REPO_ID)
    await runtime.listGitLabRepoLabels(TEST_REPO_ID)
    await runtime.createGitLabRepoIssue(TEST_REPO_ID, 'Title', 'Body')
    await runtime.updateGitLabRepoIssue(TEST_REPO_ID, 7, { body: 'Updated' })
    await runtime.addGitLabRepoIssueComment(TEST_REPO_ID, 7, 'Comment')

    expect(listGitLabMergeRequestsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitLabWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'opened',
      1,
      20,
      undefined,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitLabIssuesMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      undefined,
      null,
      localGitOptions,
      1
    )
    expect(listGitLabTodosMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, localGitOptions)
    expect(listGitLabLabelsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
    expect(createGitLabIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'Title',
      'Body',
      undefined,
      null,
      localGitOptions
    )
    expect(updateGitLabIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      { body: 'Updated' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabIssueCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
  })

  it('routes runtime GitLab MR details, review-management, job, and pasted URL actions through the selected WSL project runtime', async () => {
    setPlatform('win32')
    const runtimeStore = {
      ...store,
      getProjects: () => [
        {
          id: 'project-1',
          displayName: 'repo',
          badgeColor: 'blue',
          sourceRepoIds: [TEST_REPO_ID],
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' },
          createdAt: 0,
          updatedAt: 0
        }
      ],
      getSettings: () => ({
        ...store.getSettings(),
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const inlineInput = {
      body: 'Inline',
      path: 'src/app.ts',
      line: 12,
      baseSha: 'base',
      startSha: 'start',
      headSha: 'head'
    }
    getGitLabWorkItemDetailsMock.mockResolvedValue({ body: 'Details' })
    updateGitLabMRMock.mockResolvedValue({ ok: true })
    updateGitLabMRReviewersMock.mockResolvedValue({ ok: true, reviewers: [] })
    addGitLabMRCommentMock.mockResolvedValue({ ok: true })
    addGitLabMRInlineCommentMock.mockResolvedValue({ ok: true })
    resolveGitLabMRDiscussionMock.mockResolvedValue({ ok: true })
    getGitLabJobTraceMock.mockResolvedValue({ ok: true, trace: 'trace' })
    retryGitLabJobMock.mockResolvedValue({ ok: true })
    mergeGitLabMRMock.mockResolvedValue({ ok: true })
    closeGitLabMRMock.mockResolvedValue({ ok: true })
    reopenGitLabMRMock.mockResolvedValue({ ok: true })
    getGitLabWorkItemByProjectRefMock.mockResolvedValue({ type: 'mr', number: 8 })

    await runtime.getGitLabRepoWorkItemDetails(TEST_REPO_ID, 8, 'mr')
    await runtime.updateGitLabRepoMR(TEST_REPO_ID, 8, { title: 'Renamed' })
    await runtime.updateGitLabRepoMRReviewers(TEST_REPO_ID, 8, [1])
    await runtime.addGitLabRepoMRComment(TEST_REPO_ID, 8, 'Comment')
    await runtime.addGitLabRepoMRInlineComment(TEST_REPO_ID, 8, inlineInput)
    await runtime.resolveGitLabRepoMRDiscussion(TEST_REPO_ID, 8, 'discussion-1', true)
    await runtime.getGitLabRepoJobTrace(TEST_REPO_ID, 99)
    await runtime.retryGitLabRepoJob(TEST_REPO_ID, 99)
    await runtime.mergeGitLabRepoMR(TEST_REPO_ID, 8, 'squash')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'closed')
    await runtime.updateGitLabRepoMRState(TEST_REPO_ID, 8, 'opened')
    await runtime.getGitLabRepoWorkItemByPath(
      TEST_REPO_ID,
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr'
    )

    expect(getGitLabWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      { title: 'Renamed' },
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(updateGitLabMRReviewersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      [1],
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabMRCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'Comment',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(addGitLabMRInlineCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      inlineInput,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(resolveGitLabMRDiscussionMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'discussion-1',
      true,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getGitLabJobTraceMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(retryGitLabJobMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      99,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(mergeGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      'squash',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(closeGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(reopenGitLabMRMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      8,
      undefined,
      null,
      undefined,
      localGitOptions
    )
    expect(getGitLabWorkItemByProjectRefMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      { host: 'gitlab.com', path: 'g/p' },
      8,
      'mr',
      null,
      localGitOptions
    )
  })

  it('normalizes runtime GitLab issue list arguments like the desktop IPC path', async () => {
    const runtime = new OrcaRuntimeService(store as never)

    await runtime.listGitLabRepoIssues(
      TEST_REPO_ID,
      'closed',
      'someone-else' as never,
      250.8,
      20_000
    )
    await runtime.listGitLabRepoIssues(TEST_REPO_ID, 'all', '@me', 0.7, 0)
    await runtime.listGitLabRepoIssues(
      TEST_REPO_ID,
      'unexpected' as never,
      '@me',
      Number.NaN,
      Number.NaN
    )

    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      1,
      TEST_REPO_PATH,
      100,
      undefined,
      'closed',
      undefined,
      null,
      {},
      10_000
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      2,
      TEST_REPO_PATH,
      1,
      undefined,
      'all',
      '@me',
      null,
      {},
      1
    )
    expect(listGitLabIssuesMock).toHaveBeenNthCalledWith(
      3,
      TEST_REPO_PATH,
      20,
      undefined,
      'opened',
      '@me',
      null,
      {},
      1
    )
  })
})
