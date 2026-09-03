import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import {
  listStoredWorktreeRowsForRepo,
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
  lineageById: Record<string, WorktreeLineage>
  scanRepo: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['scanRepo']>>
  listFolderWorkspaces: ReturnType<typeof vi.fn<RepoWorktreeRowDeps['listFolderWorkspaces']>>
} {
  const metaById: Record<string, WorktreeMeta> = {}
  const lineageById: Record<string, WorktreeLineage> = {}
  const store = {
    getRepos: () => repos,
    getAllWorktreeMeta: () => metaById,
    getAllWorktreeLineage: () => lineageById,
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
  return { store, metaById, lineageById, scanRepo, listFolderWorkspaces }
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
  it('uses the host-qualified metadata owner when a legacy row has another host', async () => {
    const deps = createDeps([
      repo('shared', '/remote/repo', {
        connectionId: 'builder',
        executionHostId: 'ssh:builder'
      })
    ])
    const worktreeId = 'shared::/same/worktree'
    const remoteMeta = {
      displayName: 'remote workspace',
      hostId: 'ssh:builder',
      instanceId: 'remote-instance'
    } as unknown as WorktreeMeta
    deps.metaById[worktreeId] = {
      displayName: 'stale local workspace',
      hostId: 'local',
      instanceId: 'local-instance'
    } as unknown as WorktreeMeta
    ;(
      deps.store as Store & {
        getWorktreeMetaForHost: () => WorktreeMeta
      }
    ).getWorktreeMetaForHost = () => remoteMeta

    const rows = await resolveRepoWorktreeRows(
      deps,
      deps.store.getRepos()[0]!,
      deps.metaById,
      new Map()
    )

    expect(rows[0]).toMatchObject({
      displayName: 'remote workspace',
      hostId: 'ssh:builder',
      instanceId: 'remote-instance'
    })
  })

  it('restores canonical-only SSH rows without leaking colliding local metadata', () => {
    const local = repo('shared', '/local/repo', { executionHostId: 'local' })
    const remote = repo('shared', '/remote/repo', {
      connectionId: 'builder',
      executionHostId: 'ssh:builder'
    })
    const deps = createDeps([local, remote])
    deps.metaById['shared::/local/worktree'] = {
      displayName: 'local workspace',
      hostId: 'local'
    } as WorktreeMeta
    ;(
      deps.store as Store & {
        getAllWorktreeMetaForHost: () => Record<string, WorktreeMeta>
      }
    ).getAllWorktreeMetaForHost = () => ({
      'shared::/remote/worktree': {
        displayName: 'remote workspace',
        hostId: 'ssh:builder'
      } as unknown as WorktreeMeta
    })

    expect(listStoredWorktreeRowsForRepo(deps.store, remote, 2)).toEqual([
      expect.objectContaining({ path: '/remote/worktree' })
    ])
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

  it.each([
    [
      'exact child ID',
      'repo-child::/same/worktree',
      'repo-parent::/parent/worktree',
      'repo-child::/same/worktree'
    ],
    [
      'a trailing slash on the child ID',
      'repo-child::/same/worktree',
      'repo-parent::/parent/worktree',
      'repo-child::/same/worktree/'
    ],
    [
      'a doubled separator on the child ID',
      'repo-child::/same/worktree',
      'repo-parent::/parent/worktree',
      'repo-child::/same//worktree'
    ],
    [
      'an NFD child ID',
      'repo-child::/same/café',
      'repo-parent::/parent/worktree',
      `repo-child::${'/same/café'.normalize('NFD')}`
    ],
    [
      'a trailing slash on the parent ID',
      'repo-child::/same/worktree',
      'repo-parent::/parent/worktree',
      'repo-parent::/parent/worktree/'
    ]
  ])(
    'falls back to fleet resolution for cross-repo lineage requested with %s',
    async (_label, childId, parentId, requestedId) => {
      const deps = createDeps([
        repo('repo-child', '/local/child-repo', { executionHostId: 'local' }),
        repo('repo-parent', '/local/parent-repo', { executionHostId: 'local' })
      ])
      deps.lineageById[childId] = {
        worktreeId: childId,
        worktreeInstanceId: 'child-instance',
        parentWorktreeId: parentId,
        parentWorktreeInstanceId: 'parent-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }

      await expect(resolveScopedWorktreeIdRow(deps, requestedId, 'local')).resolves.toBeNull()
      expect(deps.scanRepo).not.toHaveBeenCalled()
    }
  )

  it('ignores colliding cross-repo lineage owned by another host', async () => {
    const childId = 'repo-child::/same/worktree'
    const parentId = 'repo-parent::/parent/worktree'
    const deps = createDeps([
      repo('repo-child', '/local/child-repo', { executionHostId: 'local' }),
      repo('repo-child', '/remote/child-repo', { executionHostId: 'ssh:builder' }),
      repo('repo-parent', '/remote/parent-repo', { executionHostId: 'ssh:builder' })
    ])
    deps.lineageById[childId] = {
      worktreeId: childId,
      worktreeInstanceId: 'remote-child-instance',
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'remote-parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    ;(
      deps.store as Store & {
        getWorktreeMetaForHost: (
          worktreeId: string,
          hostId: ExecutionHostId
        ) => WorktreeMeta | undefined
      }
    ).getWorktreeMetaForHost = (worktreeId, hostId) => {
      if (hostId !== 'ssh:builder') {
        return undefined
      }
      return worktreeId === childId
        ? ({ instanceId: 'remote-child-instance', hostId } as unknown as WorktreeMeta)
        : ({ instanceId: 'remote-parent-instance', hostId } as unknown as WorktreeMeta)
    }

    await expect(resolveScopedWorktreeIdRow(deps, childId, 'local')).resolves.toMatchObject({
      id: childId,
      hostId: 'local'
    })
    expect(deps.scanRepo.mock.calls.map(([owner]) => owner)).toEqual([
      expect.objectContaining({ path: '/local/child-repo' })
    ])

    deps.scanRepo.mockClear()
    await expect(resolveScopedWorktreeIdRow(deps, childId, 'ssh:builder')).resolves.toBeNull()
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
