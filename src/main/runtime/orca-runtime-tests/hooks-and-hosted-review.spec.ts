import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addGitHubIssueCommentMock,
  countGitHubWorkItemsMock,
  createGitHubIssueMock,
  getGitHubPRCheckDetailsMock,
  getGitHubWorkItemByOwnerRepoMock,
  getGitHubWorkItemDetailsMock,
  getGitHubWorkItemMock,
  getIssueMock,
  getRepoSlugMock,
  getRepoUpstreamMock,
  listGitHubAssignableUsersMock,
  listGitHubIssuesMock,
  listGitHubLabelsMock,
  listGitHubWorkItemsMock,
  parseOrcaYaml,
  registerSshFilesystemProvider,
  removeGitHubPRReviewersMock,
  requestGitHubPRReviewersMock,
  setPlatform,
  unregisterSshFilesystemProvider,
  updateGitHubIssueMock
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  describe('checkRepoHooks status', () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }

    it('reports an error when the SSH filesystem provider is unavailable', async () => {
      const runtime = new OrcaRuntimeService(remoteStore as never)

      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toEqual({
        status: 'error',
        hasHooks: false,
        hooks: null,
        mayNeedUpdate: false
      })
    })

    it('reports ok for a missing remote orca.yaml and error for any other read failure', async () => {
      const readFile = vi.fn()
      registerSshFilesystemProvider('ssh-1', { readFile } as never)
      const runtime = new OrcaRuntimeService(remoteStore as never)

      try {
        readFile.mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
        await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
          status: 'ok',
          hasHooks: false
        })

        readFile.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'ECONNRESET' }))
        await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({
          status: 'error',
          hasHooks: false
        })
      } finally {
        unregisterSshFilesystemProvider('ssh-1')
      }
    })

    it('reports ok for a local repo hook check', async () => {
      const runtime = new OrcaRuntimeService(store as never)

      await expect(runtime.checkRepoHooks('id:repo-1')).resolves.toMatchObject({ status: 'ok' })
    })
  })

  it('resolves SSH issue commands from shared orca.yaml and deletes empty overrides', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({
      scripts: {},
      issueCommand: 'claude -p "Fix #{{issue}}"'
    })
    const fsProvider = {
      readFile: vi.fn(async (filePath: string) => {
        if (filePath.endsWith('.orca/issue-command')) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        }
        if (filePath.endsWith('orca.yaml')) {
          return { content: 'issueCommand: claude -p "Fix #{{issue}}"', isBinary: false }
        }
        return { content: '', isBinary: false }
      }),
      writeFile: vi.fn().mockResolvedValue(undefined),
      createDir: vi.fn().mockResolvedValue(undefined),
      deletePath: vi.fn().mockResolvedValue(undefined)
    }
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.readRepoIssueCommand('id:repo-1')).resolves.toMatchObject({
        localContent: null,
        sharedContent: 'claude -p "Fix #{{issue}}"',
        effectiveContent: 'claude -p "Fix #{{issue}}"',
        localFilePath: '/remote/repo/.orca/issue-command',
        source: 'shared'
      })
      await expect(runtime.writeRepoIssueCommand('id:repo-1', '   ')).resolves.toEqual({
        ok: true
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('/remote/repo/orca.yaml')
    expect(fsProvider.deletePath).toHaveBeenCalledWith('/remote/repo/.orca/issue-command', false)
    expect(fsProvider.writeFile).not.toHaveBeenCalledWith(
      '/remote/repo/.orca/issue-command',
      expect.anything()
    )
  })

  it('allows host integration slug helpers for SSH repos through provider-aware GitHub clients', async () => {
    const prRepo = { owner: 'acme', repo: 'orca', host: 'github.acme.test' }
    getIssueMock.mockResolvedValueOnce({ number: 12, title: 'Remote issue' })
    listGitHubIssuesMock.mockResolvedValueOnce({
      items: [{ number: 7, title: 'Remote issue list item' }]
    })
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const runtime = new OrcaRuntimeService(remoteStore as never)

    await expect(runtime.getRepoSlug('id:repo-1')).resolves.toBeNull()
    await expect(runtime.getRepoIssue('id:repo-1', 12)).resolves.toEqual({
      number: 12,
      title: 'Remote issue'
    })
    await expect(runtime.listRepoIssues('id:repo-1', 10)).resolves.toEqual([
      { number: 7, title: 'Remote issue list item' }
    ])
    await expect(runtime.requestRepoPRReviewers('id:repo-1', 7, ['alex'], prRepo)).resolves.toEqual(
      {
        ok: true
      }
    )
    await expect(runtime.removeRepoPRReviewers('id:repo-1', 7, ['alex'], prRepo)).resolves.toEqual({
      ok: true
    })
    expect(getIssueMock).toHaveBeenCalledWith('/remote/repo', 12, 'ssh-1')
    expect(listGitHubIssuesMock).toHaveBeenCalledWith('/remote/repo', 10, undefined, 'ssh-1')
    expect(requestGitHubPRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      ['alex'],
      'ssh-1',
      prRepo
    )
    expect(removeGitHubPRReviewersMock).toHaveBeenCalledWith(
      '/remote/repo',
      7,
      ['alex'],
      'ssh-1',
      prRepo
    )
  })

  it('routes runtime GitHub repo identity helpers through the selected WSL project runtime', async () => {
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
    getRepoSlugMock.mockResolvedValueOnce({ owner: 'acme', repo: 'orca' })
    getRepoUpstreamMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })

    await expect(runtime.getRepoSlug('id:repo-1')).resolves.toEqual({
      owner: 'acme',
      repo: 'orca'
    })
    await expect(runtime.getRepoUpstream('id:repo-1')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })

    const runtimeOptions = { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    expect(getRepoSlugMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, runtimeOptions)
    expect(getRepoUpstreamMock).toHaveBeenCalledWith(TEST_REPO_PATH, null, runtimeOptions)
  })

  it('routes runtime GitHub issue and work-item actions through the selected WSL project runtime', async () => {
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
    const issueFields = { labels: ['bug'], assignees: ['octo'] }
    const issueUpdates = { body: 'Updated body' }
    listGitHubWorkItemsMock.mockResolvedValueOnce({ items: [] })
    countGitHubWorkItemsMock.mockResolvedValueOnce(0)
    listGitHubIssuesMock.mockResolvedValueOnce({ items: [] })
    getIssueMock.mockResolvedValueOnce(null)
    createGitHubIssueMock.mockResolvedValueOnce({
      ok: true,
      number: 12,
      url: 'https://github.com/acme/orca/issues/12'
    })
    updateGitHubIssueMock.mockResolvedValueOnce({ ok: true })
    addGitHubIssueCommentMock.mockResolvedValueOnce({ ok: true })
    listGitHubLabelsMock.mockResolvedValueOnce([])
    listGitHubAssignableUsersMock.mockResolvedValueOnce([])

    await runtime.listRepoWorkItems('id:repo-1', 7, 'is:open', 1, true)
    await runtime.countRepoWorkItems('id:repo-1', 'is:issue')
    await runtime.listRepoIssues('id:repo-1', 5)
    await runtime.getRepoIssue('id:repo-1', 12)
    await runtime.createRepoIssue('id:repo-1', 'Title', 'Body', issueFields)
    await runtime.updateRepoIssue('id:repo-1', 12, issueUpdates)
    await runtime.addRepoIssueComment('id:repo-1', 12, 'Comment')
    await runtime.listRepoLabels('id:repo-1')
    await runtime.listRepoAssignableUsers('id:repo-1')

    expect(listGitHubWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      7,
      'is:open',
      1,
      undefined,
      null,
      true,
      localGitOptions
    )
    expect(countGitHubWorkItemsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'is:issue',
      undefined,
      null,
      localGitOptions
    )
    expect(listGitHubIssuesMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      5,
      undefined,
      null,
      localGitOptions
    )
    expect(getIssueMock).toHaveBeenCalledWith(TEST_REPO_PATH, 12, null, localGitOptions)
    expect(createGitHubIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      'Title',
      'Body',
      undefined,
      null,
      issueFields,
      localGitOptions
    )
    expect(updateGitHubIssueMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      12,
      issueUpdates,
      null,
      localGitOptions
    )
    expect(addGitHubIssueCommentMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      12,
      'Comment',
      null,
      null,
      localGitOptions
    )
    expect(listGitHubLabelsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
    expect(listGitHubAssignableUsersMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      undefined,
      null,
      localGitOptions
    )
  })

  it('pins explicit origin preference on runtime open-by-number work item lookups', async () => {
    const originRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtime = new OrcaRuntimeService({
      ...store,
      getRepos: () => [originRepo],
      getRepo: (id: string) => (id === originRepo.id ? originRepo : undefined)
    } as never)
    const prRepo = { owner: 'acme', repo: 'orca' }

    await runtime.getRepoWorkItem('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemDetails('id:repo-1', 42, 'pr')
    await runtime.getRepoWorkItemByOwnerRepo('id:repo-1', prRepo, 42, 'pr')

    expect(getGitHubWorkItemMock).toHaveBeenCalledWith(TEST_REPO_PATH, 42, 'pr', null, {}, 'origin')
    expect(getGitHubWorkItemDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      42,
      'pr',
      null,
      {},
      'origin'
    )
    // Why: explicit owner/repo already pins identity, so it stays preference-free.
    expect(getGitHubWorkItemByOwnerRepoMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      prRepo,
      42,
      'pr',
      null
    )
  })

  it('forwards check-details cancellation without local Git overrides', async () => {
    const runtime = new OrcaRuntimeService(store)
    const signal = new AbortController().signal

    await runtime.getRepoPRCheckDetails('id:repo-1', { checkRunId: 9 }, signal)

    expect(getGitHubPRCheckDetailsMock).toHaveBeenCalledWith(
      TEST_REPO_PATH,
      {
        checkRunId: 9,
        prRepo: null
      },
      null,
      {},
      signal
    )
  })
})
