import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import {
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  type RepoWorktreeRowDeps
} from './repo-worktree-row-resolution'

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
  metaById: Record<string, WorktreeMeta>
  scanRepo: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['scanRepo']>>
  listFolderWorkspaces: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['listFolderWorkspaces']>>
} {
  const metaById: Record<string, WorktreeMeta> = {}
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getAllWorktreeLineage: () => ({}),
    getProjects: () => [],
    getSettings: () => ({}),
    setWorktreeMeta: (worktreeId: string, updates: Partial<WorktreeMeta>) => {
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
  it('scans only the selected local or SSH owner when repo ids and paths collide', async () => {
    const owners = [
      repo('shared', '/local/repo', { executionHostId: 'local' }),
      repo('shared', '/remote/repo', {
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      }),
      repo('unrelated', '/unrelated/repo', { connectionId: 'slow-box' })
    ]
    const deps = createDeps(owners)
    const worktreeId = 'shared::/same/worktree'

    await expect(
      resolveScopedWorktreeIdRow(deps, worktreeId, 'ssh:builder')
    ).resolves.toMatchObject({ id: worktreeId, hostId: 'ssh:builder' })
    expect(deps.scanRepo.mock.calls.map(([owner]) => owner)).toEqual([owners[1]])

    deps.scanRepo.mockClear()
    await expect(resolveScopedWorktreeIdRow(deps, worktreeId, 'local')).resolves.toMatchObject({
      id: worktreeId,
      hostId: 'local'
    })
    expect(deps.scanRepo.mock.calls.map(([owner]) => owner)).toEqual([owners[0]])
  })

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

  it.each([
    ['runtime:windows', String.raw`C:\Users\dev\orca worktree`],
    ['local', '/mnt/c/Users/dev/orca worktree']
  ] satisfies [ExecutionHostId, string][])(
    'keeps %s path resolution scoped',
    async (hostId, path) => {
      const target = repo('shared', path, { executionHostId: hostId })
      const deps = createDeps([
        target,
        repo('shared', '/other-host/repo', { executionHostId: 'ssh:unrelated' }),
        repo('unrelated', '/unrelated/repo')
      ])
      deps.scanRepo.mockImplementation(async () => ({ ok: true, worktrees: [gitWorktree(path)] }))
      const worktreeId = `shared::${path}`

      await expect(resolveScopedWorktreeIdRow(deps, worktreeId, hostId)).resolves.toMatchObject({
        id: worktreeId,
        hostId,
        path
      })
      expect(deps.scanRepo.mock.calls.map(([owner]) => owner)).toEqual([target])
    }
  )

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

  it('does not scan when the requested host does not own the repo id', async () => {
    const deps = createDeps([
      repo('shared', '/local/repo', { executionHostId: 'local' }),
      repo('unrelated', '/unrelated/repo', { executionHostId: 'runtime:other' })
    ])

    await expect(
      resolveScopedWorktreeIdRow(deps, 'shared::/same/worktree', 'ssh:builder')
    ).resolves.toBeNull()
    expect(deps.scanRepo).not.toHaveBeenCalled()
  })

  it('reuses fleet owner counts without reloading repos per row', async () => {
    const owners = Array.from({ length: 100 }, (_, index) =>
      repo(`repo-${index}`, `/repos/${index}`, { executionHostId: 'local' })
    )
    const deps = createDeps(owners)
    const getRepos = vi.spyOn(deps.store, 'getRepos')

    await Promise.all(
      owners.map((owner) => resolveRepoWorktreeRows(deps, owner, deps.metaById, new Map(), 1))
    )

    expect(getRepos).not.toHaveBeenCalled()
  })
})

/**
 * #16243: the renderer can only address a workspace by `id:<repoId>::<path>`, and this scoped
 * lookup is what a host-qualified removal resolves through. It matched the id byte for byte while a
 * `path:` selector has always compared through `normalizeRuntimePathForComparison`, so a stored id
 * spelling its path differently from `git worktree list` resolved for the CLI and not for the UI.
 */
describe('scoped worktree id resolution across path spellings (#16243)', () => {
  it.each([
    ['a trailing slash', '/same/worktree', 'shared::/same/worktree/'],
    ['a doubled separator', '/same/worktree', 'shared::/same//worktree'],
    ['an NFD name', '/same/café', `shared::${'/same/café'.normalize('NFD')}`]
  ])('resolves the scanned row when the id carries %s', async (_label, scannedPath, worktreeId) => {
    const owner = repo('shared', '/local/repo', { executionHostId: 'local' })
    const deps = createDeps([owner])
    deps.scanRepo.mockImplementation(async () => ({
      ok: true,
      worktrees: [gitWorktree(scannedPath)]
    }))

    await expect(resolveScopedWorktreeIdRow(deps, worktreeId, 'local')).resolves.toMatchObject({
      id: `shared::${scannedPath}`,
      path: scannedPath
    })
  })

  it('still refuses the same path under a different repo id', async () => {
    const deps = createDeps([
      repo('shared', '/local/repo', { executionHostId: 'local' }),
      repo('unrelated', '/unrelated/repo', { executionHostId: 'local' })
    ])

    await expect(
      resolveScopedWorktreeIdRow(deps, 'unrelated::/same/worktree/', 'local')
    ).resolves.toBeNull()
  })

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

  it('prefers the exactly matching row over an equivalent spelling', async () => {
    const owner = repo('shared', '/local/repo', { executionHostId: 'local' })
    const deps = createDeps([owner])
    deps.scanRepo.mockImplementation(async () => ({
      ok: true,
      worktrees: [gitWorktree('/same//worktree'), gitWorktree('/same/worktree')]
    }))

    await expect(
      resolveScopedWorktreeIdRow(deps, 'shared::/same//worktree', 'local')
    ).resolves.toMatchObject({ id: 'shared::/same//worktree' })
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

  it.each([
    ['no repo boundary', 'not-an-id'],
    ['an empty path', 'shared::']
  ])('keeps exact matching for a malformed id with %s', async (_label, worktreeId) => {
    const deps = createDeps([repo('shared', '/local/repo', { executionHostId: 'local' })])

    await expect(resolveScopedWorktreeIdRow(deps, worktreeId, 'local')).resolves.toBeNull()
    expect(deps.scanRepo).not.toHaveBeenCalled()
  })
})
