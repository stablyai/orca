import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import type { Store } from '../persistence'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'
import { buildDetectedGitWorktrees } from '../ipc/worktrees/listing/ssh-worktree-fallback'
import type { WorktreeLineage } from '../../shared/worktree/lineage-types'
import {
  listStoredWorktreeRowsForRepo,
  projectRepoWorktreeRowsLineage,
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

describe('cross-repo lineage (#8886)', () => {
  const repoA = repo('repo-a', '/a', { executionHostId: 'local' })
  const repoB = repo('repo-b', '/b', { executionHostId: 'local' })
  const parentId = 'repo-a::/a/parent'
  const childId = 'repo-b::/b/child'
  const meta = (hostId: ExecutionHostId, instanceId: string): WorktreeMeta =>
    mergeWorktreeMetaForWrite(undefined, { hostId, instanceId })

  function createCrossRepoDeps(
    repos: Repo[],
    lineageById: Record<string, WorktreeLineage>
  ): ReturnType<typeof createDeps> {
    const deps = createDeps(repos)
    Object.assign(deps.store, { getAllWorktreeLineage: () => lineageById })
    deps.scanRepo.mockImplementation(async (owner) => ({
      ok: true,
      worktrees: [gitWorktree(owner.id === 'repo-a' ? '/a/parent' : '/b/child')]
    }))
    deps.metaById[parentId] = meta('local', 'parent-instance')
    deps.metaById[childId] = meta('local', 'child-instance')
    return deps
  }

  const crossRepoLineage = (): Record<string, WorktreeLineage> => ({
    [childId]: {
      worktreeId: childId,
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: parentId,
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
  })

  async function fleetRows(deps: ReturnType<typeof createDeps>, repos: Repo[]) {
    const perRepo = await Promise.all(
      repos.map(async (owner) => ({
        repo: owner,
        rows: await resolveRepoWorktreeRows(deps, owner, deps.metaById, new Map())
      }))
    )
    return projectRepoWorktreeRowsLineage(perRepo, deps.store.getAllWorktreeLineage())
  }

  it('projects a same-host edge across repos in the fleet scan, keeping repo order', async () => {
    const deps = createCrossRepoDeps([repoA, repoB], crossRepoLineage())

    const rows = await fleetRows(deps, [repoA, repoB])

    expect(rows).toMatchObject([
      { id: parentId, childWorktreeIds: [childId], parentWorktreeId: null },
      { id: childId, parentWorktreeId: parentId, childWorktreeIds: [] }
    ])
  })

  it('does not link repos on different execution hosts', async () => {
    const remoteA = repo('repo-a', '/a', { connectionId: 'box', executionHostId: 'ssh:box' })
    const deps = createCrossRepoDeps([remoteA, repoB], crossRepoLineage())
    deps.metaById[parentId] = meta('ssh:box', 'parent-instance')

    const rows = await fleetRows(deps, [remoteA, repoB])

    expect(rows).toMatchObject([
      { id: parentId, childWorktreeIds: [] },
      { id: childId, parentWorktreeId: null }
    ])
  })

  it.each([
    ['cross-repo child', childId],
    ['cross-repo parent', parentId]
  ])(
    'defers a %s to the fleet scan instead of reporting a one-repo projection',
    async (_label, worktreeId) => {
      const deps = createCrossRepoDeps([repoA, repoB], crossRepoLineage())

      await expect(resolveScopedWorktreeIdRow(deps, worktreeId, 'local')).resolves.toBeNull()
      const fleet = (await fleetRows(deps, [repoA, repoB])).find((row) => row.id === worktreeId)
      expect(fleet?.parentWorktreeId ?? fleet?.childWorktreeIds[0]).toBeTruthy()
    }
  )

  it('keeps the one-repo fast path for intra-repo lineage', async () => {
    const siblingId = 'repo-a::/a/sibling'
    const deps = createCrossRepoDeps([repoA, repoB], {
      [siblingId]: {
        ...crossRepoLineage()[childId],
        worktreeId: siblingId,
        worktreeInstanceId: 'sibling-instance'
      }
    })
    deps.scanRepo.mockImplementation(async () => ({
      ok: true,
      worktrees: [gitWorktree('/a/parent'), gitWorktree('/a/sibling')]
    }))
    deps.metaById[siblingId] = meta('local', 'sibling-instance')

    await expect(resolveScopedWorktreeIdRow(deps, parentId, 'local')).resolves.toMatchObject({
      id: parentId,
      childWorktreeIds: [siblingId]
    })
  })
})
