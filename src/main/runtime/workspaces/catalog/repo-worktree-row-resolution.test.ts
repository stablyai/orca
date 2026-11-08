import { describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'

import type { GitWorktreeInfo, Worktree } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import { mergeWorktreeMetaForWrite } from '../../../persistence/loading-store/worktree-meta-write-normalization'
import { buildDetectedGitWorktrees } from '../../../ipc/worktrees/listing/ssh-worktree-fallback'
import {
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  type RepoWorktreeRowDeps
} from './repo-worktree-row-resolution'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'

function repo(
  id: string,
  path: string,
  options: Pick<Repo, 'connectionId' | 'executionHostId' | 'kind'> = {}
): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: 'blue',
    addedAt: 1,
    ...options
  }
}

function gitWorktree(path: string): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false
  }
}

function createDeps(repos: Repo[]): RepoWorktreeRowDeps & {
  store: Store
  metaById: Record<string, WorktreeMeta>
  scanRepo: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['scanRepo']>>
  listFolderWorkspaces: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['listFolderWorkspaces']>>
} {
  const metaById: Record<string, WorktreeMeta> = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store mock; the code under test reads only the members it defines.
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getAllWorktreeLineage: () => ({}),
    getProjects: () => [],
    getSettings: () => ({}),
    setWorktreeMeta: ({ id: worktreeId }: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      const next = { ...metaById[worktreeId], ...updates } as WorktreeMeta
      metaById[worktreeId] = next
      return next
    }
  } as unknown as Store
  const scanRepo = vi.fn<RepoWorktreeRowDeps['scanRepo']>(async (owner) => ({
    ok: true,
    worktrees: [gitWorktree(owner.id === 'unrelated' ? '/unrelated/worktree' : '/same/worktree')]
  }))
  const listFolderWorkspaces = vi.fn<RepoWorktreeRowDeps['listFolderWorkspaces']>(() => [])
  return { store, metaById, scanRepo, listFolderWorkspaces }
}

describe('host-qualified scoped worktree resolution', () => {
  it('does not project another host metadata onto a colliding scoped row', async () => {
    const deps = createDeps([
      repo('shared', '/local/repo', { executionHostId: 'local' }),
      repo('shared', '/remote/repo', {
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      })
    ])
    const worktreeId = 'shared::/same/worktree'
    deps.metaById[worktreeId] = {
      displayName: 'local workspace',
      hostId: 'local',
      instanceId: 'local-instance',
      preserveBranchOnDelete: true
    } as WorktreeMeta

    await expect(
      resolveScopedWorktreeIdRow(deps, worktreeId, 'ssh:builder')
    ).resolves.toMatchObject({
      id: worktreeId,
      hostId: 'ssh:builder',
      displayName: 'feature'
    })
  })

  it('resolves only the selected folder-workspace owner without scanning Git providers', async () => {
    const local = repo('folders', '/local/folders', {
      kind: 'folder',
      executionHostId: 'local'
    })
    const remote = repo('folders', '/remote/folders', {
      kind: 'folder',
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })
    const deps = createDeps([local, remote, repo('unrelated', '/unrelated/repo')])
    const worktreeId = 'folders::/shared/folder'
    deps.listFolderWorkspaces.mockImplementation((owner) =>
      owner === remote
        ? ([
            {
              id: worktreeId,
              repoId: owner.id,
              path: '/shared/folder',
              head: '',
              branch: '',
              isBare: false,
              isMainWorktree: false,
              displayName: 'folder',
              comment: '',
              hostId: 'ssh:builder'
            } as unknown as Worktree
          ] as Worktree[])
        : []
    )

    await expect(
      resolveScopedWorktreeIdRow(deps, worktreeId, 'ssh:builder')
    ).resolves.toMatchObject({ id: worktreeId, hostId: 'ssh:builder' })
    expect(deps.listFolderWorkspaces).toHaveBeenCalledExactlyOnceWith(remote, 2)
    expect(deps.scanRepo).not.toHaveBeenCalled()
  })
})

/** Normalize id-selector paths like path selectors so UI removal resolves the same host-qualified row as CLI (#16243). */
describe('scoped worktree id resolution across path spellings (#16243)', () => {
  it('refuses rather than guessing when two rows spell one path', async () => {
    const owner = repo('shared', '/local/repo', { executionHostId: 'local' })
    const deps = createDeps([owner])
    deps.scanRepo.mockImplementation(async () => ({
      ok: true,
      worktrees: [gitWorktree('/same/worktree'), gitWorktree('/same//worktree')]
    }))

    await expect(
      resolveScopedWorktreeIdRow(deps, 'shared::/same/worktree/', 'local')
    ).resolves.toBeNull()
  })

  // #15598/#15616: the backslash spelling is what a pre-restart Windows registration recorded.
  it('resolves a Windows backslash id against the forward-slash spelling git reports', async () => {
    const path = 'D:/Agentic/game2/battle-core'
    const owner = repo('shared', 'D:/Agentic/game2', { executionHostId: 'runtime:windows' })
    const deps = createDeps([owner])
    deps.scanRepo.mockImplementation(async () => ({ ok: true, worktrees: [gitWorktree(path)] }))

    await expect(
      resolveScopedWorktreeIdRow(deps, 'shared::D:\\Agentic\\game2\\battle-core', 'runtime:windows')
    ).resolves.toMatchObject({ id: `shared::${path}`, path })
  })
})

describe('folder-to-Git checkout identity', () => {
  it.each([
    ['C:\\projects\\draft', 'C:/projects/draft'],
    ['C:\\projects\\draft', 'c:/projects/draft']
  ])(
    'preserves the live folder locator %s in desktop and runtime listings',
    async (folderPath, gitPath) => {
      const owner = {
        ...repo('folder', folderPath),
        kind: 'git' as const,
        folderUpgradeGitRootPath: gitPath
      }
      const deps = createDeps([owner])
      const oldId = `folder::${folderPath}`
      const metadata = mergeWorktreeMetaForWrite(undefined, {
        hostId: 'local',
        instanceId: 'existing-omp',
        comment: 'keep me'
      })
      deps.metaById[oldId] = metadata
      Object.assign(deps.store, { getProjectHostSetups: () => [] })
      deps.scanRepo.mockResolvedValue({ ok: true, worktrees: [gitWorktree(gitPath)] })

      const detected = buildDetectedGitWorktrees(deps.store, owner, [gitWorktree(gitPath)])
      const rows = await resolveRepoWorktreeRows(deps, owner, deps.metaById, new Map())
      for (const result of [detected, rows]) {
        expect(result).toHaveLength(1)
        expect(result[0]).toMatchObject({
          id: oldId,
          path: folderPath,
          instanceId: 'existing-omp',
          comment: 'keep me'
        })
      }
      expect(Object.keys(deps.metaById)).toEqual([oldId])
    }
  )
})
