import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => {
  const ipcMain = {
    on: vi.fn(() => ipcMain),
    removeListener: vi.fn(() => ipcMain),
    emit: vi.fn(() => true)
  }
  return {
    BrowserWindow: { fromId: vi.fn((): unknown => null) },
    webContents: { fromId: vi.fn((): unknown => null) },
    ipcMain,
    app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
  }
})
vi.mock('electron', () => electronMocks)

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: (connectionId: string) => getSshGitProviderMock(connectionId)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())
vi.mock('../git/worktree', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorktreesStrict: listWorktreesStrictMock
}))

import { OrcaRuntimeService } from './orca-runtime'

const LOCAL_REPO_ID = 'repo-local'
const LOCAL_REPO_PATH = '/Users/me/dev/app'
const SSH_REPO_ID = 'repo-ssh'
const SSH_REPO_PATH = '/home/user/app'
const SSH_CONNECTION_ID = 'box-1'

function gitWorktree(path: string, isMain = false) {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: isMain }
}

/** Local rows sort ahead of the remote ones, mirroring the fleet order that starves the cap. */
function makeStore() {
  const metaById: Record<string, unknown> = {}
  return {
    getRepo: (id: string) =>
      makeStore()
        .getRepos()
        .find((repo) => repo.id === id),
    getRepos: () => [
      {
        id: LOCAL_REPO_ID,
        path: LOCAL_REPO_PATH,
        displayName: 'app',
        badgeColor: 'blue',
        addedAt: 1
      },
      {
        id: SSH_REPO_ID,
        path: SSH_REPO_PATH,
        displayName: 'app remote',
        badgeColor: 'blue',
        addedAt: 2,
        connectionId: SSH_CONNECTION_ID
      }
    ],
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...(metaById[id] as object), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined as never,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
}

describe('worktree.ps host coverage', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([
      gitWorktree(LOCAL_REPO_PATH, true),
      gitWorktree(`${LOCAL_REPO_PATH}-a`),
      gitWorktree(`${LOCAL_REPO_PATH}-b`),
      gitWorktree(`${LOCAL_REPO_PATH}-c`)
    ])
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn(async () => [
        gitWorktree(SSH_REPO_PATH, true),
        gitWorktree(`${SSH_REPO_PATH}-a`)
      ])
    })
  })

  it('names every host the page covers', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)

    const result = await runtime.getWorktreePs(10_000)

    expect(result.hostScope?.hostIds).toEqual(['local', `ssh:${SSH_CONNECTION_ID}`])
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  it('keeps a remote row in the page when the cap cannot hold every local row', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)

    const result = await runtime.getWorktreePs(2)

    expect(result.truncated).toBe(true)
    expect(result.worktrees).toHaveLength(2)
    expect(result.worktrees.map((worktree) => worktree.hostId)).toContain(
      `ssh:${SSH_CONNECTION_ID}`
    )
    expect(result.hostScope?.hostIds).toEqual(['local', `ssh:${SSH_CONNECTION_ID}`])
  })
})
