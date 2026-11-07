import { getAppEnvironment } from '../../../../shared/app-environment'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { orcadMigrationCutoverFixture } from '../../../ssh/orcad-migration-cutover-fixture'
import { writeOrcadMigrationSourceCutover } from '../../../ssh/orcad-migration-cutover-journal'
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

const listWorktreesStrictMock = vi.hoisted(() => vi.fn())

import { OrcaRuntimeService } from '../../orca-runtime'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

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
  // Why: this process serves no SSH git, so the SSH repo lists its stored rows.
  const metaById: Record<string, unknown> = {
    [`${SSH_REPO_ID}::${SSH_REPO_PATH}`]: {
      hostId: `ssh:${SSH_CONNECTION_ID}`
    },
    [`${SSH_REPO_ID}::${SSH_REPO_PATH}-a`]: {
      hostId: `ssh:${SSH_CONNECTION_ID}`
    }
  }
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
    setWorktreeMeta: ({ id }: HostWorktreeTarget, meta: Record<string, unknown>) => {
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
    listWorktreesStrictMock.mockReset()
    listWorktreesStrictMock.mockResolvedValue([
      gitWorktree(LOCAL_REPO_PATH, true),
      gitWorktree(`${LOCAL_REPO_PATH}-a`),
      gitWorktree(`${LOCAL_REPO_PATH}-b`),
      gitWorktree(`${LOCAL_REPO_PATH}-c`)
    ])
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
  it('hides retained folder sources and their host after conversion without losing visible host labels', async () => {
    const sourceFolder: FolderWorkspace = {
      id: 'converted-notes',
      projectGroupId: 'notes',
      name: 'Notes',
      folderPath: '/srv/notes',
      connectionId: 'converted-box',
      executionHostId: 'ssh:converted-box',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const store = {
      ...makeStore(),
      getFolderWorkspaces: () => [
        sourceFolder,
        { ...sourceFolder, id: 'local-notes', connectionId: null, executionHostId: 'local' },
        { ...sourceFolder, id: 'other-notes', connectionId: 'box-1', executionHostId: 'ssh:box-1' }
      ],
      getProjectGroups: () => [{ id: 'notes', name: 'Notes', parentPath: '/srv' }],
      getSshTargets: () => [{ id: 'converted-box', orcadFence: { environmentId: 'env-1' } }]
    }
    const cutover = orcadMigrationCutoverFixture('ps-conversion', 'converted-box')
    const userData = getAppEnvironment().getPath('userData')
    writeOrcadMigrationSourceCutover(userData, cutover)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listing reads only the catalog and metadata methods supplied by this fixture.
    const runtime = new OrcaRuntimeService(store as never)
    const before = await runtime.getWorktreePs(10_000)
    expect(
      before.worktrees.find((row) => row.worktreeId === 'folder:converted-notes')?.hostId
    ).toBe('ssh:converted-box')

    writeOrcadMigrationSourceCutover(userData, { ...cutover, phase: 'destination-committed' })
    const after = await runtime.getWorktreePs(10_000)
    expect(
      after.worktrees
        .filter((row) => row.workspaceKind === 'folder-workspace')
        .map((row) => ({ id: row.worktreeId, hostId: row.hostId }))
    ).toEqual([
      { id: 'folder:local-notes', hostId: 'local' },
      { id: 'folder:other-notes', hostId: 'ssh:box-1' }
    ])
    expect(after.hostScope).toEqual({
      hostIds: ['local', 'ssh:box-1'],
      omittedHostIds: []
    })
  })
})
