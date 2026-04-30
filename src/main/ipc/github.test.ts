import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getPRForBranchMock, getIssueMock, listIssuesMock, getAuthenticatedViewerMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    getPRForBranchMock: vi.fn(),
    getIssueMock: vi.fn(),
    listIssuesMock: vi.fn(),
    getAuthenticatedViewerMock: vi.fn()
  }))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock,
  getIssue: getIssueMock,
  listIssues: listIssuesMock,
  getAuthenticatedViewer: getAuthenticatedViewerMock
}))

import { registerGitHubHandlers } from './github'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerGitHubHandlers', () => {
  const handlers: HandlerMap = {}
  const store = {
    getRepos: () => [
      {
        id: 'repo-1',
        path: '/workspace/repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0
      }
    ]
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
    getAuthenticatedViewerMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

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

    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/test')
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

  it('forwards listIssues for registered repositories and unwraps items', async () => {
    listIssuesMock.mockResolvedValue({ items: [] })

    registerGitHubHandlers(store as never, stats as never)

    const result = await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5)
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

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5)
    expect(result).toEqual([])
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
})
