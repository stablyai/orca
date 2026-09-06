// SSH ownership has two spellings on a repo row: the legacy `connectionId` field and the unified
// `executionHostId: 'ssh:*'`. This suite pins the scan and the terminal launch that follows it for
// the second spelling — the seam #17909 identified but could not test end to end (#11163).
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

vi.mock('./repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

import { OrcaRuntimeService } from './orca-runtime'

const TARGET_ID = 'remote-1'
const REPO_ID = 'repo-remote'
const REPO_PATH = '/srv/app'
const WORKTREE_PATH = '/srv/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`

function makeMeta(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

/** One repo row owned by an SSH host, stamped with `executionHostId` only — no `connectionId`. */
function makeStore(repoOverrides: Record<string, unknown>) {
  const metaById: Record<string, ReturnType<typeof makeMeta>> = {
    [WORKTREE_ID]: makeMeta({
      hostId: `ssh:${TARGET_ID}`,
      instanceId: '11111111-1111-4111-8111-111111111111'
    }),
    [MAIN_WORKTREE_ID]: makeMeta({
      displayName: 'main',
      hostId: `ssh:${TARGET_ID}`,
      instanceId: '22222222-2222-4222-8222-222222222222'
    })
  }
  const repos = [
    {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'app',
      badgeColor: 'blue',
      addedAt: 1,
      ...repoOverrides
    }
  ]
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta } as never
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
  return store
}

type RuntimeInternals = {
  listResolvedWorktrees: () => Promise<{ id: string; path: string; hostId?: string }[]>
}

function makeRuntime(repoOverrides: Record<string, unknown>): {
  runtime: OrcaRuntimeService
  list: () => Promise<{ id: string; path: string; hostId?: string }[]>
} {
  const runtime = new OrcaRuntimeService(makeStore(repoOverrides) as never)
  return {
    runtime,
    list: () => (runtime as unknown as RuntimeInternals).listResolvedWorktrees()
  }
}

describe('worktree scan execution-host routing', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([])
  })

  it('scans an executionHostId-only SSH repo over its SSH provider, not on the client', async () => {
    const listWorktrees = vi.fn(async () => [
      { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
      { path: WORKTREE_PATH, head: 'def', branch: 'feature', isBare: false, isMainWorktree: false }
    ])
    getSshGitProviderMock.mockReturnValue({ listWorktrees })
    const { list } = makeRuntime({ executionHostId: `ssh:${TARGET_ID}` })

    const worktrees = await list()

    expect(getSshGitProviderMock).toHaveBeenCalledWith(TARGET_ID)
    expect(listWorktrees).toHaveBeenCalledWith(REPO_PATH)
    // A client-side `git worktree list` against a remote path is the silent-substitution failure.
    expect(listWorktreesStrictMock).not.toHaveBeenCalled()
    expect(worktrees.map((worktree) => worktree.path).sort()).toEqual([REPO_PATH, WORKTREE_PATH])
    expect(worktrees.every((worktree) => worktree.hostId === `ssh:${TARGET_ID}`)).toBe(true)
  })

  it('routes the PTY of an executionHostId-only SSH worktree to its host', async () => {
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: async () => [
        { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
        {
          path: WORKTREE_PATH,
          head: 'def',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]
    })
    const { runtime } = makeRuntime({ executionHostId: `ssh:${TARGET_ID}` })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    } as never)

    await runtime.createTerminal(`id:${WORKTREE_ID}`)

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: TARGET_ID, cwd: WORKTREE_PATH })
    )
  })

  it('still routes a legacy connectionId-only SSH repo the same way', async () => {
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: async () => [
        { path: REPO_PATH, head: 'abc', branch: 'main', isBare: false, isMainWorktree: true },
        {
          path: WORKTREE_PATH,
          head: 'def',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]
    })
    const { runtime } = makeRuntime({ connectionId: TARGET_ID })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    } as never)

    await runtime.createTerminal(`id:${WORKTREE_ID}`)

    expect(getSshGitProviderMock).toHaveBeenCalledWith(TARGET_ID)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: TARGET_ID, cwd: WORKTREE_PATH })
    )
  })
})
