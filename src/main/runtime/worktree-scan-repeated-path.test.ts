// Git lists a path twice when a linked registration's gitdir names the main checkout (#23631).
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

const localScanMock = vi.hoisted(() => vi.fn())
vi.mock('./repo-worktree-resolution-scan', () => ({
  scanLocalRepoWorktreesForResolution: localScanMock
}))

vi.mock('./repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

const getSshGitProviderMock = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSshGitProvider: getSshGitProviderMock
}))

import { OrcaRuntimeService } from './orca-runtime'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

const REPO_ID = 'repo-local'
const REPO_PATH = '/home/me/fileLoc'
const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`
const MAIN_ROW = {
  path: REPO_PATH,
  head: 'abc',
  branch: 'refs/heads/dev_ops',
  isBare: false,
  isMainWorktree: true
}
// Linux paths are case-sensitive: a different spelling is a different checkout.
const OTHER_SPELLING_ROW = {
  path: '/home/me/FileLoc',
  head: 'def',
  branch: 'refs/heads/feat',
  isBare: false,
  isMainWorktree: false
}

function makeRuntime(options: { connectionId?: string } = {}): OrcaRuntimeService {
  const metaById: Record<string, Record<string, unknown>> = {}
  const repos = [
    {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'fileLoc',
      badgeColor: 'blue',
      addedAt: 1,
      ...options
    }
  ]
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: (id: string, meta: Record<string, unknown>) => {
      metaById[id] = { ...metaById[id], ...meta }
      return metaById[id]
    },
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => []
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub carries the repo, meta, lineage and settings reads a worktree listing makes; the rest of Store is unreached.
  return new OrcaRuntimeService(store as never)
}

function gitLists(worktrees: GitWorktreeInfo[]): void {
  localScanMock.mockResolvedValue({ ok: true, worktrees })
}

async function listedRows(runtime: OrcaRuntimeService): Promise<string[]> {
  const listed = await runtime.listManagedWorktrees()
  return listed.worktrees.map((worktree) => `${worktree.id} ${worktree.branch}`)
}

describe('worktree scan with a repeated path', () => {
  beforeEach(() => {
    localScanMock.mockReset()
    getSshGitProviderMock.mockReset()
  })

  describe('rows that agree, as reported', () => {
    beforeEach(() => {
      gitLists([MAIN_ROW, { ...MAIN_ROW, isMainWorktree: false }, OTHER_SPELLING_ROW])
    })

    it('resolves a branch selector to the main checkout', async () => {
      await expect(makeRuntime().showManagedWorktree('branch:dev_ops')).resolves.toMatchObject({
        id: MAIN_WORKTREE_ID,
        isMainWorktree: true
      })
    })

    it('resolves the id the CLI sends for `active` and `current` after a listing', async () => {
      const runtime = makeRuntime()
      await runtime.listManagedWorktrees()

      await expect(runtime.showManagedWorktree(`id:${MAIN_WORKTREE_ID}`)).resolves.toMatchObject({
        id: MAIN_WORKTREE_ID,
        isMainWorktree: true
      })
    })

    it('lists each path once for the CLI and for paired clients', async () => {
      const runtime = makeRuntime()
      const expectedIds = [MAIN_WORKTREE_ID, `${REPO_ID}::/home/me/FileLoc`]

      const listed = await runtime.listManagedWorktrees()
      expect(listed.worktrees.map((worktree) => worktree.id)).toEqual(expectedIds)

      const detected = await runtime.listDetectedManagedWorktrees(`id:${REPO_ID}`)
      expect(detected.worktrees.map((worktree) => worktree.id)).toEqual(expectedIds)
    })
  })

  // What git prints for a registration whose gitdir names the main checkout: its own branch and HEAD.
  it('keeps the main checkout over a stale registration on another branch', async () => {
    gitLists([
      MAIN_ROW,
      { ...MAIN_ROW, head: 'old', branch: 'refs/heads/stale', isMainWorktree: false }
    ])
    const runtime = makeRuntime()

    await expect(listedRows(runtime)).resolves.toEqual([`${MAIN_WORKTREE_ID} refs/heads/dev_ops`])
    await expect(runtime.showManagedWorktree('branch:stale')).rejects.toThrow('selector_not_found')
  })

  it('lists an SSH repo the remote host repeats once', async () => {
    getSshGitProviderMock.mockReturnValue({
      listWorktrees: vi.fn(async () => [MAIN_ROW, { ...MAIN_ROW, isMainWorktree: false }])
    })

    await expect(listedRows(makeRuntime({ connectionId: 'builder' }))).resolves.toEqual([
      `${MAIN_WORKTREE_ID} refs/heads/dev_ops`
    ])
    expect(localScanMock).not.toHaveBeenCalled()
  })
})
