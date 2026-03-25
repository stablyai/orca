import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getPRForBranchMock, getIssueMock, listIssuesMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getPRForBranchMock: vi.fn(),
  getIssueMock: vi.fn(),
  listIssuesMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../github/client', () => ({
  getPRForBranch: getPRForBranchMock,
  getIssue: getIssueMock,
  listIssues: listIssuesMock
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

  beforeEach(() => {
    handleMock.mockReset()
    getPRForBranchMock.mockReset()
    getIssueMock.mockReset()
    listIssuesMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }

    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
  })

  it('normalizes registered repo paths before invoking github clients', async () => {
    getPRForBranchMock.mockResolvedValue({ number: 42 })

    registerGitHubHandlers(store as never)

    await handlers['gh:prForBranch'](null, {
      repoPath: '/workspace/repo/../repo',
      branch: 'feature/test'
    })

    expect(getPRForBranchMock).toHaveBeenCalledWith('/workspace/repo', 'feature/test')
  })

  it('rejects unknown repository paths', async () => {
    registerGitHubHandlers(store as never)

    expect(() =>
      handlers['gh:issue'](null, {
        repoPath: '/workspace/other',
        number: 7
      })
    ).toThrow('Access denied: unknown repository path')

    expect(getIssueMock).not.toHaveBeenCalled()
  })

  it('forwards listIssues for registered repositories', async () => {
    listIssuesMock.mockResolvedValue([])

    registerGitHubHandlers(store as never)

    await handlers['gh:listIssues'](null, {
      repoPath: '/workspace/repo',
      limit: 5
    })

    expect(listIssuesMock).toHaveBeenCalledWith('/workspace/repo', 5)
  })
})
