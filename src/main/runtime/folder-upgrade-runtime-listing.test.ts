// A folder project upgraded to Git keeps the folder's locator in every runtime listing (#30150).
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

import { OrcaRuntimeService } from './orca-runtime'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta,
  type PartialRuntimeStore
} from './runtime-store-partial-fixture'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'

const REPO_ID = 'repo-upgraded'
const FOLDER_PATH = 'D:\\project\\a'
const GIT_PATH = 'D:/project/a'
const FOLDER_WORKTREE_ID = `${REPO_ID}::${FOLDER_PATH}`

function makeRuntime(): OrcaRuntimeService {
  const metaById: Record<string, WorktreeMeta> = {
    [FOLDER_WORKTREE_ID]: storeWorktreeMeta({
      displayName: 'Draft',
      hostId: 'local',
      instanceId: 'kept'
    })
  }
  const repos = [
    storeRepo({
      id: REPO_ID,
      path: FOLDER_PATH,
      displayName: 'a',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'git',
      folderUpgradeGitRootPath: GIT_PATH
    })
  ]
  const store: PartialRuntimeStore = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...storeWorktreeMeta(), ...metaById[id], ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: ({ id }: HostWorktreeTarget) => {
      delete metaById[id]
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
  return new OrcaRuntimeService(partialRuntimeStore(store))
}

describe('folder-upgraded checkout in runtime listings', () => {
  beforeEach(() => {
    localScanMock.mockReset()
    localScanMock.mockResolvedValue({
      ok: true,
      worktrees: [
        {
          path: GIT_PATH,
          head: 'abc',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]
    })
  })

  it('publishes the folder spelling to paired clients, with its metadata', async () => {
    const detected = await makeRuntime().listDetectedManagedWorktrees(`id:${REPO_ID}`)

    expect(detected.worktrees).toHaveLength(1)
    expect(detected.worktrees[0]).toMatchObject({
      id: FOLDER_WORKTREE_ID,
      path: FOLDER_PATH,
      displayName: 'Draft',
      instanceId: 'kept'
    })
  })

  it('agrees with the resolved listing the CLI reads', async () => {
    const runtime = makeRuntime()
    const listed = await runtime.listManagedWorktrees()
    const detected = await runtime.listDetectedManagedWorktrees(`id:${REPO_ID}`)

    expect(listed.worktrees.map((worktree) => worktree.id)).toEqual([FOLDER_WORKTREE_ID])
    expect(detected.worktrees.map((worktree) => worktree.id)).toEqual([FOLDER_WORKTREE_ID])
  })
})
