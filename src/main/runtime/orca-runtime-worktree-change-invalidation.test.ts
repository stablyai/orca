// A headless host never loads `ipc/worktrees`, the desktop module that registers the scan-generation
// bump, so this suite deliberately does not import it: the runtime itself must make a worktree change
// reach the generation its listing witnesses and the scan cache that listing reads through.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { DetectedWorktreeListResult } from '../../shared/worktree/types'

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

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn(),
  getSshGitProviderGeneration: vi.fn(() => 0),
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'unavailable',
  requireSshGitProvider: vi.fn()
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
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import { getLocalWorktreeScanGeneration } from '../local-worktree-scan-generation'

const REPO_ID = 'repo-local'
const REPO_PATH = '/Users/me/dev/app'
const CREATED_PATH = '/Users/me/dev/app-created'

const repo: Repo = {
  id: REPO_ID,
  path: REPO_PATH,
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1
}

function row(path: string) {
  return { path, head: 'abc', branch: 'main', isBare: false, isMainWorktree: path === REPO_PATH }
}

function makeStore() {
  return {
    getRepo: (id: string) => (id === REPO_ID ? repo : undefined),
    getRepos: () => [repo],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined,
    setWorktreeMeta: vi.fn(),
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
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

function makeRuntimeService(): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every store member the local listing reaches is supplied above.
  return new OrcaRuntimeService(makeStore() as never)
}

function makeRuntime(): () => Promise<DetectedWorktreeListResult> {
  const runtime = makeRuntimeService()
  return () => runtime.listDetectedManagedWorktrees(`id:${REPO_ID}`)
}

describe('runtime worktree change invalidation', () => {
  beforeEach(() => {
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([row(REPO_PATH)])
  })

  it('moves the scan generation the runtime listing witnesses', () => {
    makeRuntime()
    const before = getLocalWorktreeScanGeneration(REPO_ID)

    runWorktreeChangeInvalidators(REPO_ID)

    expect(getLocalWorktreeScanGeneration(REPO_ID)).not.toBe(before)
  })

  it('bumps that generation from the change event the runtime itself sends, with no window notifier attached', () => {
    const runtime = makeRuntimeService()
    const before = getLocalWorktreeScanGeneration(REPO_ID)

    runtime.notifyBranchRenamed(REPO_ID)

    expect(getLocalWorktreeScanGeneration(REPO_ID)).not.toBe(before)
  })

  it('clears the runtime scan cache so the next listing scans again', async () => {
    const list = makeRuntime()

    await list()
    await list()
    expect(listWorktreesStrictMock).toHaveBeenCalledTimes(1)

    runWorktreeChangeInvalidators(REPO_ID)
    await list()
    expect(listWorktreesStrictMock).toHaveBeenCalledTimes(2)
  })

  it('re-lists a scan a worktree change overtook and publishes the rows that include the change', async () => {
    const list = makeRuntime()
    listWorktreesStrictMock
      .mockImplementationOnce(async () => {
        // The worktree becomes listable while this scan is in flight.
        runWorktreeChangeInvalidators(REPO_ID)
        return [row(REPO_PATH)]
      })
      .mockResolvedValueOnce([row(REPO_PATH), row(CREATED_PATH)])

    const result = await list()

    expect(listWorktreesStrictMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ authoritative: true, source: 'git' })
    expect(result.worktrees.map((worktree) => worktree.path).sort()).toEqual([
      REPO_PATH,
      CREATED_PATH
    ])
  })
})
