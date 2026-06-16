/* eslint-disable max-lines -- Why: GitHub IPC tests share one mocked Electron
handler harness; keeping the related route wiring together avoids duplicated setup. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  getPRForBranchMock,
  getIssueMock,
  listIssuesMock,
  listWorkItemsMock,
  listLabelsMock,
  listAssignableUsersMock,
  getAuthenticatedViewerMock,
  mergePRMock,
  setPRAutoMergeMock,
  checkOrcaStarredMock,
  starOrcaMock,
  trackMock,
  getCohortAtEmitMock,
  getAllWebContentsMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  getIssueMock: vi.fn(),
  listIssuesMock: vi.fn(),
  listWorkItemsMock: vi.fn(),
  listLabelsMock: vi.fn(),
  listAssignableUsersMock: vi.fn(),
  getAuthenticatedViewerMock: vi.fn(),
  mergePRMock: vi.fn(),
  setPRAutoMergeMock: vi.fn(),
  checkOrcaStarredMock: vi.fn(),
  starOrcaMock: vi.fn(),
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(),
  getAllWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  webContents: {
    getAllWebContents: getAllWebContentsMock
  }
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock,
  getIssue: getIssueMock,
  listIssues: listIssuesMock,
  listWorkItems: listWorkItemsMock,
  listLabels: listLabelsMock,
  listAssignableUsers: listAssignableUsersMock,
  getAuthenticatedViewer: getAuthenticatedViewerMock,
  mergePR: mergePRMock,
  setPRAutoMerge: setPRAutoMergeMock,
  checkOrcaStarred: checkOrcaStarredMock,
  starOrca: starOrcaMock
}))

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

import { registerGitHubHandlers } from './github'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerGitHubHandlers', () => {
  const handlers: HandlerMap = {}
  type FixtureRepo = {
    id: string
    path: string
    displayName: string
    badgeColor: string
    addedAt: number
    connectionId?: string | null
    executionHostId?: string | null
    issueSourcePreference?: 'origin' | 'upstream'
  }
  let repos: FixtureRepo[] = []
  const store = {
    getRepos: () => repos
  }
  const stats = {
    hasCountedPR: () => false,
    record: vi.fn()
  }

  beforeEach(() => {
    handleMock.mockReset()
    getPRForBranchMock.mockReset()
    getIssueMock.mockReset()
    listIssuesMock.mockReset()
    listWorkItemsMock.mockReset()
    listLabelsMock.mockReset()
    listAssignableUsersMock.mockReset()
    getAuthenticatedViewerMock.mockReset()
    mergePRMock.mockReset()
    setPRAutoMergeMock.mockReset()
    checkOrcaStarredMock.mockReset()
    starOrcaMock.mockReset()
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: undefined })
    getAllWebContentsMock.mockReset()
    getAllWebContentsMock.mockReturnValue([])
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    // Reset fixture repos to the default single-repo fixture each test, so
    // individual tests can mutate the list without leaking preferences across
    // tests (e.g. a preference-threading test could otherwise shadow the
    // default-undefined assertions in sibling tests).
    repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ]

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  it('normalizes registered repo paths before invoking github clients', async () => {
    getPRForBranchMock.mockResolvedValue({ number: 42 })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:prForBranch'](null, {
      repoPath: '/workspace/repo/../repo',
      branch: 'feature/test'
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith(
      '/workspace/repo',
      'feature/test',
      null,
      null,
      null
    )
  })

  it('rejects unknown repository paths', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(() =>
      handlers['gh:issue'](null, {
        repoPath: '/workspace/other',
        number: 7
      })
    ).toThrow('Access denied: unknown repository path')

    expect(getIssueMock).not.toHaveBeenCalled()
  })

  it('rejects GitHub source context from a different host', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(() =>
      handlers['gh:listWorkItems'](null, {
        repoPath: '/workspace/repo',
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-1',
          hostId: 'ssh:openclaw-2',
          repoId: 'repo-1'
        }
      })
    ).toThrow('Access denied: GitHub source host does not match repository host')

    expect(listWorkItemsMock).not.toHaveBeenCalled()
  })

  it('guards label metadata lookups with source host context', async () => {
    listLabelsMock.mockResolvedValue(['bug'])
    repos = [
      ...repos,
      {
        id: 'repo-ssh',
        path: '/workspace/remote-repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'openclaw-2',
        executionHostId: 'ssh:openclaw-2'
      }
    ]
    registerGitHubHandlers(store as never, stats as never)

    await expect(
      handlers['gh:listLabels'](null, {
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        sourceContext: {
          kind: 'task-source',
          provider: 'github',
          projectId: 'project-1',
          hostId: 'ssh:openclaw-2',
          repoId: 'repo-ssh'
        }
      })
    ).resolves.toEqual(['bug'])

    expect(listLabelsMock).toHaveBeenCalledWith('/workspace/remote-repo', undefined, 'openclaw-2')
  })

  it('forwards listIssues for registered repositories and unwraps items', async () => {
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('drops the error field from listIssues envelope at the IPC boundary', async () => {
    // Why: src/main/ipc/github.ts intentionally unwraps the { items, error? }
    // envelope to just `items` to preserve the pre-feature-1
    // `Promise<IssueInfo[]>` contract for `gh:listIssues`. Feature 1's UI
    // consumes the richer envelope through `gh:listWorkItems` instead. This
    // test locks in that intentional drop so a future change that starts
    // propagating the error through this channel (or that throws when an
    // error is present) is caught.
    listIssuesMock.mockResolvedValue({
      items: [],
      error: {
        type: 'permission_denied',
        message:
          "You don't have permission to read issues for this repository. Check your GitHub token scopes."
      }
    })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, undefined, null)
    expect(result).toEqual([])
  })

  it('threads issueSourcePreference through gh:listIssues', async () => {
    // Why: repo.issueSourcePreference must reach listIssues so the upstream
    // repo is queried when configured. A regression that drops the arg would
    // pass the default-fixture tests (which assert `undefined`) silently, so
    // this test pins the non-undefined preference-threading contract.
    repos[0].issueSourcePreference = 'upstream'
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5, 'upstream', null)
  })

  it('threads issueSourcePreference through gh:listWorkItems', async () => {
    // Why: gh:listWorkItems must also forward repo.issueSourcePreference
    // (5th arg) so the work-items view honors the per-repo source selector.
    repos[0].issueSourcePreference = 'origin'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: 'is:open',
      before: 'cursor-1',
      noCache: true
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      'is:open',
      'cursor-1',
      'origin',
      null,
      true
    )
  })

  it('threads SSH connectionId through GitHub work-item handlers', async () => {
    repos[0].connectionId = 'openclaw-2'
    listWorkItemsMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:listWorkItems'](null, {
      repoPath: '/workspace/repo',
      limit: 10,
      query: ''
    })

    expect(listWorkItemsMock).toHaveBeenCalledWith(
      '/workspace/repo',
      10,
      '',
      undefined,
      undefined,
      'openclaw-2',
      undefined
    )
  })

  it('threads SSH connectionId through pull request merge', async () => {
    repos[0].connectionId = 'openclaw-2'
    mergePRMock.mockResolvedValue({ ok: true })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:mergePR'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        method: 'squash',
        prRepo: { owner: 'acme', repo: 'orca' }
      }
    )

    expect(mergePRMock).toHaveBeenCalledWith('/workspace/repo', 42, 'squash', 'openclaw-2', {
      owner: 'acme',
      repo: 'orca'
    })
  })

  it('threads SSH connectionId through pull request auto-merge', async () => {
    repos[0].connectionId = 'openclaw-2'
    setPRAutoMergeMock.mockResolvedValue({ ok: true })

    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:setPRAutoMerge'](
      { sender: { id: 1 } },
      {
        repoPath: '/workspace/repo',
        prNumber: 42,
        enabled: true,
        method: 'squash',
        prRepo: { owner: 'acme', repo: 'orca' }
      }
    )

    expect(setPRAutoMergeMock).toHaveBeenCalledWith(
      '/workspace/repo',
      42,
      true,
      'squash',
      'openclaw-2',
      {
        owner: 'acme',
        repo: 'orca'
      }
    )
  })

  it('forwards the authenticated viewer lookup', async () => {
    getAuthenticatedViewerMock.mockResolvedValue({ login: 'octocat', email: 'octocat@example.com' })

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:viewer'](null, undefined)).resolves.toEqual({
      login: 'octocat',
      email: 'octocat@example.com'
    })
    expect(getAuthenticatedViewerMock).toHaveBeenCalled()
  })

  it('emits app_starred_orca once after a successful star with cohort context', async () => {
    starOrcaMock.mockResolvedValue(true)
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 3 })

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'settings')).resolves.toBe(true)

    expect(starOrcaMock).toHaveBeenCalledTimes(1)
    expect(getCohortAtEmitMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledTimes(1)
    expect(trackMock).toHaveBeenCalledWith('app_starred_orca', {
      source: 'settings',
      nth_repo_added: 3
    })
  })

  it('accepts every app star source for success telemetry', async () => {
    starOrcaMock.mockResolvedValue(true)

    registerGitHubHandlers(store as never, stats as never)

    for (const source of ['star_nag', 'settings', 'landing'] as const) {
      await expect(handlers['gh:starOrca'](null, source)).resolves.toBe(true)
    }

    expect(trackMock).toHaveBeenCalledTimes(3)
    expect(trackMock.mock.calls.map(([, props]) => props)).toEqual([
      { source: 'star_nag', nth_repo_added: undefined },
      { source: 'settings', nth_repo_added: undefined },
      { source: 'landing', nth_repo_added: undefined }
    ])
  })

  it('does not emit app_starred_orca when the star action returns false', async () => {
    starOrcaMock.mockResolvedValue(false)

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'landing')).resolves.toBe(false)

    expect(starOrcaMock).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  it('does not emit app_starred_orca when the star action throws', async () => {
    starOrcaMock.mockRejectedValue(new Error('gh failed'))

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'star_nag')).rejects.toThrow('gh failed')

    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })

  it('preserves star result but skips telemetry for an invalid IPC source', async () => {
    starOrcaMock.mockResolvedValue(true)

    registerGitHubHandlers(store as never, stats as never)

    await expect(handlers['gh:starOrca'](null, 'github_website')).resolves.toBe(true)

    expect(starOrcaMock).toHaveBeenCalledTimes(1)
    expect(trackMock).not.toHaveBeenCalled()
    expect(getCohortAtEmitMock).not.toHaveBeenCalled()
  })
})
