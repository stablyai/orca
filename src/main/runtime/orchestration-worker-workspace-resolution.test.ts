import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const scanLocalRepoWorktreesForResolution = vi.hoisted(() => vi.fn())
vi.mock('./repo-worktree-resolution-scan', () => ({ scanLocalRepoWorktreesForResolution }))

const getSshGitProvider = vi.hoisted(() => vi.fn())
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider,
  getSshGitProviderGeneration: vi.fn(() => 0),
  requireSshGitProvider: (connectionId: string) => getSshGitProvider(connectionId)
}))

import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { OrcaRuntimeService } from './orca-runtime'

const REPO_ID = 'repo-1'
const REPO_PATH = '/repo'
const WORKTREE_PATH = '/repo/feature'
const WORKTREE_ID = `${REPO_ID}::${WORKTREE_PATH}`

function makeMeta(displayName: string, hostId?: WorktreeMeta['hostId']): WorktreeMeta {
  return {
    displayName,
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
    ...(hostId ? { hostId } : {})
  }
}

function makeStore(
  options: {
    repos?: Repo[]
    meta?: Record<string, WorktreeMeta>
    folderWorkspaces?: FolderWorkspace[]
    projectGroups?: ProjectGroup[]
  } = {}
) {
  const repos = options.repos ?? [
    {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'App',
      badgeColor: 'blue',
      addedAt: 1
    }
  ]
  const meta = options.meta ?? { [WORKTREE_ID]: makeMeta('Feature') }
  const store = {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getRepos: () => repos,
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: (id: string, patch: Partial<WorktreeMeta>) => {
      meta[id] = { ...(meta[id] ?? makeMeta('')), ...patch }
      return meta[id]
    },
    getAllWorktreeLineage: () => ({}),
    getAllWorkspaceLineage: () => ({}),
    removeWorktreeLineage: vi.fn(),
    removeWorkspaceLineage: vi.fn(),
    getGitHubCache: () => undefined,
    getSettings: () => ({
      workspaceDir: '/tmp/workspaces',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: 'none',
      branchPrefixCustom: ''
    }),
    getProjects: () => [],
    getFolderWorkspaces: () => options.folderWorkspaces ?? [],
    getProjectGroups: () => options.projectGroups ?? []
  }
  return store
}

describe('orchestration worker workspace resolution', () => {
  const tempPaths: string[] = []

  beforeEach(() => {
    scanLocalRepoWorktreesForResolution.mockReset().mockResolvedValue({
      ok: true,
      worktrees: [
        {
          path: WORKTREE_PATH,
          head: 'abc',
          branch: 'feature',
          isBare: false,
          isMainWorktree: false
        }
      ]
    })
    getSshGitProvider.mockReset()
  })

  afterEach(async () => {
    await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  })

  it.each([
    ['full id', `id:${WORKTREE_ID}`],
    ['path', `path:${WORKTREE_PATH}`],
    ['name', 'name:Feature']
  ])('resolves a local worktree by %s with one catalog scan', async (_label, selector) => {
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(runtime.showManagedTerminalWorkspace(selector)).resolves.toMatchObject({
      id: WORKTREE_ID,
      path: WORKTREE_PATH
    })
    expect(scanLocalRepoWorktreesForResolution).toHaveBeenCalledOnce()
  })

  it('preserves a disconnected SSH worktree with unknown legacy ownership', async () => {
    const remoteRepo = {
      id: REPO_ID,
      path: REPO_PATH,
      displayName: 'Remote app',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    } satisfies Repo
    const runtime = new OrcaRuntimeService(
      makeStore({
        repos: [remoteRepo],
        meta: { [WORKTREE_ID]: makeMeta('Remote feature') }
      }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace(`id:${WORKTREE_ID}`)).resolves.toMatchObject({
      id: WORKTREE_ID,
      hostId: 'ssh:ssh-1'
    })
  })

  it('does not fall back from the floating terminal sentinel to another workspace', async () => {
    const runtime = new OrcaRuntimeService(makeStore() as never)

    await expect(
      runtime.showManagedTerminalWorkspace(`id:${FLOATING_TERMINAL_WORKTREE_ID}`)
    ).rejects.toThrow('selector_not_found')
    expect(scanLocalRepoWorktreesForResolution).not.toHaveBeenCalled()
  })

  it('rejects an ambiguous worktree name', async () => {
    const secondPath = '/repo/other'
    scanLocalRepoWorktreesForResolution.mockResolvedValue({
      ok: true,
      worktrees: [
        { path: WORKTREE_PATH, head: 'a', branch: 'one', isBare: false, isMainWorktree: false },
        { path: secondPath, head: 'b', branch: 'two', isBare: false, isMainWorktree: false }
      ]
    })
    const runtime = new OrcaRuntimeService(
      makeStore({
        meta: {
          [WORKTREE_ID]: makeMeta('Duplicate'),
          [`${REPO_ID}::${secondPath}`]: makeMeta('Duplicate')
        }
      }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace('name:Duplicate')).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  it('rejects the same worktree path on different execution hosts', async () => {
    const remoteRepo = {
      id: 'repo-remote',
      path: '/remote-repo',
      displayName: 'Remote app',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    } satisfies Repo
    getSshGitProvider.mockReturnValue({
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: WORKTREE_PATH,
          head: 'remote',
          branch: 'remote-feature',
          isBare: false,
          isMainWorktree: false
        }
      ])
    })
    const runtime = new OrcaRuntimeService(
      makeStore({
        repos: [makeStore().getRepos()[0], remoteRepo],
        meta: {
          [WORKTREE_ID]: makeMeta('Local feature'),
          [`${remoteRepo.id}::${WORKTREE_PATH}`]: makeMeta('Remote feature')
        }
      }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace(`path:${WORKTREE_PATH}`)).rejects.toThrow(
      'selector_ambiguous'
    )
  })

  it('resolves local and SSH folder workspaces without a Git catalog scan', async () => {
    const localPath = await mkdtemp(join(tmpdir(), 'orca-worker-local-folder-'))
    tempPaths.push(localPath)
    const group = { id: 'group-1', name: 'Group', parentPath: localPath } as ProjectGroup
    const localFolder = {
      id: 'local-folder',
      projectGroupId: group.id,
      name: 'Local folder',
      folderPath: localPath
    } as FolderWorkspace
    const remoteFolder = {
      ...localFolder,
      id: 'remote-folder',
      name: 'Remote folder',
      folderPath: '/srv/app',
      connectionId: 'ssh-folder'
    }
    registerSshFilesystemProvider('ssh-folder', {
      stat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtime: 1 })
    } as never)
    try {
      const runtime = new OrcaRuntimeService(
        makeStore({
          folderWorkspaces: [localFolder, remoteFolder],
          projectGroups: [group]
        }) as never
      )

      await expect(
        runtime.showManagedTerminalWorkspace('folder:local-folder')
      ).resolves.toMatchObject({
        id: 'folder:local-folder',
        path: localPath,
        hostId: 'local'
      })
      await expect(
        runtime.showManagedTerminalWorkspace('id:folder:remote-folder')
      ).resolves.toMatchObject({ id: 'folder:remote-folder', hostId: 'ssh:ssh-folder' })
    } finally {
      unregisterSshFilesystemProvider('ssh-folder')
    }
    expect(scanLocalRepoWorktreesForResolution).not.toHaveBeenCalled()
  })

  it('rejects a folder workspace whose execution host is ambiguous', async () => {
    const folderPath = '/workspace'
    const group = { id: 'group-1', name: 'Group', parentPath: folderPath } as ProjectGroup
    const folder = {
      id: 'folder-1',
      projectGroupId: group.id,
      name: 'Ambiguous folder',
      folderPath
    } as FolderWorkspace
    const repos = [
      { id: 'local', path: '/workspace/local', projectGroupId: group.id },
      { id: 'remote', path: '/workspace/remote', projectGroupId: group.id, connectionId: 'ssh-1' }
    ].map((repo) => ({
      displayName: repo.id,
      badgeColor: 'blue',
      addedAt: 1,
      ...repo
    })) as Repo[]
    const runtime = new OrcaRuntimeService(
      makeStore({ repos, folderWorkspaces: [folder], projectGroups: [group] }) as never
    )

    await expect(runtime.showManagedTerminalWorkspace('folder:folder-1')).rejects.toThrow(
      'folder_workspace_connection_ambiguous'
    )
    expect(scanLocalRepoWorktreesForResolution).not.toHaveBeenCalled()
  })
})
