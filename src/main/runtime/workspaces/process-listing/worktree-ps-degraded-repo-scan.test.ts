import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
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
vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listWorktreesStrictMock
  }
})

vi.mock('electron', () => electronMocks)
vi.mock('../catalog/repo-worktree-admin-fingerprint', () => ({
  readRepoWorktreeAdminFingerprint: vi.fn(async () => null)
}))

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())

import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { OrcaRuntimeService } from '../../orca-runtime'
import { _resetWorktreeCatalogOwnerForTests } from '../../../workspaces/catalog/repo-worktree-catalog-owner'

import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import {
  partialRuntimeStore,
  storeRepo,
  storeWorktreeMeta
} from '../../orca-runtime-tests/runtime-store-partial-fixture'

const REPO_ID = 'repo-remote'
const REPO_PATH = '/home/user/projects/app'
const WORKTREE_PATH = '/home/user/projects/app-feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`
const SCRATCH_ID = `${REPO_ID}::${REPO_PATH}/.claude/worktrees/scratch`

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return storeWorktreeMeta({
    displayName: 'feature',
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    ...overrides
  })
}

const MAIN_WORKTREE_ID = `${REPO_ID}::${REPO_PATH}`

// Seed real lineage rows so pruning assertions discriminate.
function makeLineage(): Record<string, WorktreeLineage> {
  return {
    [WORKTREE_ID]: {
      worktreeId: WORKTREE_ID,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: MAIN_WORKTREE_ID,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'inferred' },
      createdAt: 1
    }
  }
}

type StoreOptions = {
  connectionId?: string
  metaById?: Record<string, WorktreeMeta>
  removeWorktreeLineage?: (target: HostWorktreeTarget) => void
  /** Extra `getRepos()` rows appended after the primary one, for same-id-on-two-hosts coverage. */
  coHostedRepos?: { id: string; path: string; connectionId?: string }[]
}

function makeStore(options: StoreOptions = {}) {
  const metaById = options.metaById ?? {
    [WORKTREE_ID]: makeMeta(),
    [MAIN_WORKTREE_ID]: makeMeta({ displayName: 'main', instanceId: 'parent-instance' })
  }
  const lineageById = makeLineage()
  const store = {
    getRepo: (id: string) => store.getRepos().find((repo) => repo.id === id),
    getRepos: () => [
      storeRepo({
        id: REPO_ID,
        path: REPO_PATH,
        displayName: 'app',
        badgeColor: 'blue',
        addedAt: 1,
        ...(options.connectionId === undefined ? {} : { connectionId: options.connectionId })
      }),
      ...(options.coHostedRepos ?? []).map((repo) =>
        storeRepo({ displayName: 'app', badgeColor: 'blue', addedAt: 1, ...repo })
      )
    ],
    getAllWorktreeMeta: vi.fn(() => metaById),
    getWorktreeMeta: (id: string) => metaById[id],
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Partial<WorktreeMeta>) => {
      metaById[id] = { ...(metaById[id] ?? makeMeta()), ...meta }
      return metaById[id]
    },
    removeWorktreeMeta: () => {},
    getAllWorktreeLineage: () => lineageById,
    getAllWorkspaceLineage: () => ({
      [worktreeWorkspaceKey(WORKTREE_ID)]: {
        childWorkspaceKey: worktreeWorkspaceKey(WORKTREE_ID),
        childInstanceId: 'child-instance',
        parentWorkspaceKey: worktreeWorkspaceKey(MAIN_WORKTREE_ID),
        parentInstanceId: 'parent-instance',
        origin: 'cli' as const,
        capture: { source: 'env-workspace' as const, confidence: 'inferred' as const },
        createdAt: 1
      }
    }),
    removeWorktreeLineage: options.removeWorktreeLineage ?? vi.fn(),
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

function neverSettles() {
  return new Promise<never>(() => {})
}

async function advancePastRepoScanBudget<T>(pending: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(6_000)
  return pending
}

describe('worktree.ps on a degraded repo scan', () => {
  beforeEach(() => {
    // The catalog owner is process-wide; a previous case's failed scan must not answer this one.
    _resetWorktreeCatalogOwnerForTests()
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([])
  })

  // withTimeout also falls back on rejection; absorb real scan failures before they can restore stale rows.
  it('treats a rejected scan as a real answer instead of restoring persisted worktrees', async () => {
    listWorktreesStrictMock.mockRejectedValue(new Error('git unavailable'))
    const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()))

    const result = await runtime.getWorktreePs(10_000)

    expect(result.worktrees.map((worktree) => worktree.worktreeId)).not.toContain(WORKTREE_ID)
  })

  it('lists restored worktrees while a scan is stalled and still hides agent scratch', async () => {
    vi.useFakeTimers()
    try {
      listWorktreesStrictMock.mockImplementation(neverSettles)
      const runtime = new OrcaRuntimeService(
        partialRuntimeStore(
          makeStore({
            metaById: {
              [WORKTREE_ID]: makeMeta(),
              [SCRATCH_ID]: makeMeta({ displayName: 'scratch' })
            }
          })
        )
      )

      const listed = await advancePastRepoScanBudget(runtime.listManagedWorktrees(`id:${REPO_ID}`))

      const ids = listed.worktrees.map((worktree) => worktree.id)
      expect(ids).toContain(WORKTREE_ID)
      expect(ids).not.toContain(SCRATCH_ID)
    } finally {
      vi.useRealTimers()
    }
  })
})
