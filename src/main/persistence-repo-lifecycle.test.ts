import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../shared/persisted-state-types'
import type { ProjectGroup } from '../shared/project-group-types'
import { getDefaultWorkspaceSession } from '../shared/constants'
import {
  testState,
  createStore,
  writeDataFile,
  readDataFile,
  makeRepo,
  makeTerminalTab,
  makeWorktreeLineage
} from './persistence-test-harness'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // ── 5. addRepo and getRepo ──────────────────────────────────────────

  it('addRepo stores a repo retrievable by getRepo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const fetched = store.getRepo('r1')
    expect(fetched).toBeDefined()
    expect(fetched!.displayName).toBe('test')
    // No username has been resolved yet — hydration must not probe git/gh.
    expect(fetched!.gitUsername).toBe('')
  })

  it('setResolvedRepoGitUsername persists the enriched username for hydration', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())
    expect(store.getRepo('r1')!.gitUsername).toBe('')

    expect(store.setResolvedRepoGitUsername(makeRepo(), 'testuser')).toBe(true)
    expect(store.getRepo('r1')!.gitUsername).toBe('testuser')
    // Unchanged value reports no change so callers can skip renderer notify.
    expect(store.setResolvedRepoGitUsername(makeRepo(), 'testuser')).toBe(false)
    expect(store.setResolvedRepoGitUsername(makeRepo({ id: 'missing' }), 'x')).toBe(false)
    // A repo id that exists only on another host must not fall back to the local row.
    expect(store.setResolvedRepoGitUsername(makeRepo({ connectionId: 'ssh-1' }), 'ssh-user')).toBe(
      false
    )
    expect(store.getRepo('r1')!.gitUsername).toBe('testuser')

    store.flush()
    const persisted = readDataFile() as PersistedState
    expect(persisted.repos[0].gitUsername).toBe('testuser')
  })

  it('deleteProjectGroup ungroups repos from the deleted group subtree', async () => {
    const store = await createStore()
    const root = store.createProjectGroup({ name: 'Platform', createdFrom: 'folder-scan' })
    const child = store.createProjectGroup({
      name: 'Services',
      parentGroupId: root.id,
      createdFrom: 'folder-scan'
    })
    const sibling = store.createProjectGroup({ name: 'Tools', createdFrom: 'manual' })
    store.addRepo(makeRepo({ id: 'direct', path: '/direct', projectGroupId: root.id }))
    store.addRepo(makeRepo({ id: 'nested', path: '/nested', projectGroupId: child.id }))
    store.addRepo(makeRepo({ id: 'sibling', path: '/sibling', projectGroupId: sibling.id }))

    expect(store.deleteProjectGroup(root.id)).toBe(true)

    expect(store.getProjectGroups().map((group) => group.id)).toEqual([sibling.id])
    expect(store.getRepo('direct')?.projectGroupId).toBeNull()
    expect(store.getRepo('nested')?.projectGroupId).toBeNull()
    expect(store.getRepo('sibling')?.projectGroupId).toBe(sibling.id)
  })

  it('adapts flat folder-scan groups into sparse nested folder scopes on load', async () => {
    writeDataFile({
      schemaVersion: 1,
      repos: [
        makeRepo({ id: 'api', path: '/workspace/platform/api', projectGroupId: 'root' }),
        makeRepo({ id: 'web', path: '/workspace/platform/web', projectGroupId: 'root' }),
        makeRepo({
          id: 'repo1',
          path: '/workspace/platform/packages/shared/repo1',
          projectGroupId: 'root'
        }),
        makeRepo({
          id: 'repo2',
          path: '/workspace/platform/packages/shared/repo2',
          projectGroupId: 'root'
        })
      ],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups: [
        {
          id: 'root',
          name: 'Platform',
          parentPath: '/workspace/platform',
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    const store = await createStore()
    const groups = store.getProjectGroups()
    const shared = groups.find((group) => group.name === 'packages/shared')

    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, '/workspace/platform'],
      ['packages/shared', 'root', '/workspace/platform/packages/shared']
    ])
    expect(store.getRepo('api')?.projectGroupId).toBe('root')
    expect(store.getRepo('web')?.projectGroupId).toBe('root')
    expect(store.getRepo('repo1')?.projectGroupId).toBe(shared?.id)
    expect(store.getRepo('repo2')?.projectGroupId).toBe(shared?.id)
  })

  it('creates a project group when persisted group history is very large', async () => {
    const projectGroups: ProjectGroup[] = Array.from({ length: 130_000 }, (_, index) => ({
      id: `group-${index}`,
      name: `Group ${index}`,
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: index,
      isCollapsed: false,
      color: null,
      createdAt: index,
      updatedAt: index
    }))
    writeDataFile({
      schemaVersion: 1,
      repos: [],
      worktreeMeta: {},
      settings: {},
      ui: {},
      githubCache: { pr: {}, issue: {} },
      projectGroups
    })
    const store = await createStore()

    const group = store.createProjectGroup({ name: 'New group', createdFrom: 'manual' })

    expect(group.tabOrder).toBe(projectGroups.length)
  })

  it('sanitizes invalid project group updates before persisting a repo', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
    store.addRepo(makeRepo({ id: 'r1', projectGroupId: group.id, projectGroupOrder: 1 }))

    const updated = store.updateRepo('r1', {
      projectGroupId: '',
      projectGroupOrder: Number.POSITIVE_INFINITY
    } as never)

    expect(updated?.projectGroupId).toBeNull()
    expect(updated?.projectGroupOrder).toBe(1)
  })

  it('updates repo execution host identity', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))

    const updated = store.updateRepo('r1', { executionHostId: 'runtime:env-1' })

    expect(updated?.executionHostId).toBe('runtime:env-1')
    expect(store.getRepo('r1')?.executionHostId).toBe('runtime:env-1')
  })

  it('getRepo returns undefined for nonexistent id', async () => {
    const store = await createStore()
    expect(store.getRepo('nonexistent')).toBeUndefined()
  })

  // ── 6. removeProject cleans up worktree meta ──────────────────────────

  it('removeProject deletes the repo and its worktree meta', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })
    store.setWorktreeMeta('r1::/path/wt2', { displayName: 'wt2' })
    store.setWorktreeMeta('r2::/other', { displayName: 'other' })

    store.removeProject('r1')

    expect(store.getRepo('r1')).toBeUndefined()
    expect(store.getWorktreeMeta('r1::/path/wt1')).toBeUndefined()
    expect(store.getWorktreeMeta('r1::/path/wt2')).toBeUndefined()
    expect(store.getWorktreeMeta('r2::/other')).toBeDefined()
    expect(store.getWorktreeMeta('r2::/other')!.displayName).toBe('other')
  })

  it('does not retain topology authority for historically removed repos', async () => {
    const store = await createStore()

    for (let index = 0; index < 25; index += 1) {
      const repoId = `removed-${index}`
      store.addRepo(makeRepo({ id: repoId, path: `/repo-${index}` }))
      store.setWorkspaceSession({
        ...store.getWorkspaceSession(),
        terminalTopologyRevisionByRepoId: { [repoId]: 1 }
      })
      store.removeProject(repoId)
    }

    expect(store.getWorkspaceSession().terminalTopologyRevisionByRepoId).toEqual({})
  })

  it('removeProject prunes the repo worktrees from workspace session state', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })
    store.setWorktreeMeta('r2::/other', { displayName: 'other' })

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { 'r1::/path/wt1': 111, 'r2::/other': 222 }
    })

    store.removeProject('r1')

    const session = store.getWorkspaceSession()
    expect(session.lastVisitedAtByWorktreeId?.['r1::/path/wt1']).toBeUndefined()
    expect(session.lastVisitedAtByWorktreeId?.['r2::/other']).toBe(222)
  })

  it('removeProject prunes the repo worktrees from per-host workspace session partitions', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))

    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })

    const hostId = 'ssh:host-a'
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { 'r1::/path/wt1': 333 }
      },
      hostId
    )

    store.removeProject('r1')

    const hostSession = store.getWorkspaceSession(hostId)
    expect(hostSession.lastVisitedAtByWorktreeId?.['r1::/path/wt1']).toBeUndefined()
  })

  it('lists only persisted workspace-session host partitions', async () => {
    const store = await createStore()
    expect(store.getWorkspaceSessionHostIds()).toEqual(['local'])

    store.getWorkspaceSession('ssh:not-persisted')
    store.setWorkspaceSession(getDefaultWorkspaceSession(), 'ssh:ssh-a')
    store.setWorkspaceSession(getDefaultWorkspaceSession(), 'runtime:environment-a')

    expect(store.getWorkspaceSessionHostIds()).toEqual([
      'local',
      'ssh:ssh-a',
      'runtime:environment-a'
    ])
  })

  it('removeProject removes the derived project host setup compatibility record', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.removeProject('r1')

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r2'])
    expect(store.getProjectHostSetups().map((setup) => setup.id)).toEqual(['r2'])
  })

  it('removeProject deletes child and parent lineage for the repo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1' }))
    store.addRepo(makeRepo({ id: 'r2', path: '/repo2' }))

    store.setWorktreeLineage(
      'r1::/path/child',
      makeWorktreeLineage({
        worktreeId: 'r1::/path/child',
        parentWorktreeId: 'r1::/path/parent'
      })
    )
    store.setWorktreeLineage(
      'r2::/other-child',
      makeWorktreeLineage({
        worktreeId: 'r2::/other-child',
        parentWorktreeId: 'r1::/path/parent'
      })
    )
    store.setWorktreeLineage(
      'r2::/other',
      makeWorktreeLineage({
        worktreeId: 'r2::/other',
        parentWorktreeId: 'r2::/parent'
      })
    )

    store.removeProject('r1')

    expect(store.getWorktreeLineage('r1::/path/child')).toBeUndefined()
    expect(store.getWorktreeLineage('r2::/other-child')).toBeUndefined()
    expect(store.getWorktreeLineage('r2::/other')).toBeDefined()
  })

  // ── 6b. removeProjectForHost is host-scoped ───────────────────────────

  it('removeProjectForHost removes only the target host row for a shared repo id', async () => {
    const store = await createStore()
    // Same repo id on both local and an SSH host.
    store.addRepo(makeRepo({ id: 'shared', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/remote/repo',
        connectionId: 'ssh-old',
        executionHostId: 'ssh:ssh-old'
      })
    )
    store.setWorktreeMeta('shared::/local/repo/wt', { displayName: 'local-wt', hostId: 'local' })
    store.setWorktreeMeta('shared::/remote/repo/wt', {
      displayName: 'remote-wt',
      hostId: 'ssh:ssh-old'
    })

    store.removeProjectForHost('shared', 'ssh:ssh-old')

    const remaining = store.getRepos().filter((r) => r.id === 'shared')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].path).toBe('/local/repo')
    // Local worktree meta survives; the SSH host's meta is pruned.
    expect(store.getWorktreeMeta('shared::/local/repo/wt')).toBeDefined()
    expect(store.getWorktreeMeta('shared::/remote/repo/wt')).toBeUndefined()
  })

  it('removeProjectForHost keeps the surviving host session for a shared repo id + path', async () => {
    const store = await createStore()
    // Same repo id AND same path on both local and an SSH host, so the owner key
    // `shared::/repo` is identical across hosts. The host-scoped prune must only
    // touch the removed host's session partition.
    store.addRepo(makeRepo({ id: 'shared', path: '/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/repo',
        connectionId: 'ssh-a',
        executionHostId: 'ssh:ssh-a'
      })
    )
    store.setWorktreeMeta('shared::/repo', { displayName: 'local', hostId: 'local' })

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { 'shared::/repo': 111 }
    })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { 'shared::/repo': 222 }
      },
      'ssh:ssh-a'
    )

    store.removeProjectForHost('shared', 'ssh:ssh-a')

    // The removed SSH host's session is pruned; the surviving local session stays.
    expect(
      store.getWorkspaceSession('ssh:ssh-a').lastVisitedAtByWorktreeId?.['shared::/repo']
    ).toBeUndefined()
    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.['shared::/repo']).toBe(111)
  })

  it('removeProjectForHost on the local host keeps a surviving SSH host session', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared', path: '/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/repo',
        connectionId: 'ssh-a',
        executionHostId: 'ssh:ssh-a'
      })
    )
    store.setWorktreeMeta('shared::/repo', { displayName: 'local', hostId: 'local' })

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { 'shared::/repo': 111 }
    })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { 'shared::/repo': 222 }
      },
      'ssh:ssh-a'
    )

    store.removeProjectForHost('shared', 'local')

    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.['shared::/repo']).toBeUndefined()
    expect(
      store.getWorkspaceSession('ssh:ssh-a').lastVisitedAtByWorktreeId?.['shared::/repo']
    ).toBe(222)
  })

  it('removeProjectForHost prunes only the removed host when a third host also shares the owner key', async () => {
    const store = await createStore()
    // Same repo id + path on local and two SSH hosts, so the owner key
    // `shared::/repo` is identical across all three. Removing one non-local host
    // must prune only that host's partition and leave both the local session and
    // the other surviving SSH host intact.
    store.addRepo(makeRepo({ id: 'shared', path: '/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/repo',
        connectionId: 'ssh-a',
        executionHostId: 'ssh:ssh-a'
      })
    )
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/repo',
        connectionId: 'ssh-b',
        executionHostId: 'ssh:ssh-b'
      })
    )
    store.setWorktreeMeta('shared::/repo', { displayName: 'local', hostId: 'local' })

    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { 'shared::/repo': 111 }
    })
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { 'shared::/repo': 222 }
      },
      'ssh:ssh-a'
    )
    store.setWorkspaceSession(
      {
        ...getDefaultWorkspaceSession(),
        lastVisitedAtByWorktreeId: { 'shared::/repo': 333 }
      },
      'ssh:ssh-b'
    )

    store.removeProjectForHost('shared', 'ssh:ssh-a')

    // Only the removed host's partition is pruned; local and the other SSH host survive.
    expect(
      store.getWorkspaceSession('ssh:ssh-a').lastVisitedAtByWorktreeId?.['shared::/repo']
    ).toBeUndefined()
    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.['shared::/repo']).toBe(111)
    expect(
      store.getWorkspaceSession('ssh:ssh-b').lastVisitedAtByWorktreeId?.['shared::/repo']
    ).toBe(333)
  })

  it('reorderReposForHost independently reorders local and SSH rows with shared ids', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared', path: '/local/shared' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/ssh/shared',
        connectionId: 'target'
      })
    )
    store.addRepo(makeRepo({ id: 'local-two', path: '/local/two' }))
    store.addRepo(
      makeRepo({
        id: 'ssh-two',
        path: '/ssh/two',
        connectionId: 'target'
      })
    )

    expect(store.reorderReposForHost(['local-two', 'shared'], 'local')).toBe(true)
    expect(store.getRepos().map((repo) => repo.path)).toEqual([
      '/local/two',
      '/ssh/shared',
      '/local/shared',
      '/ssh/two'
    ])

    expect(store.reorderReposForHost(['ssh-two', 'shared'], 'ssh:target')).toBe(true)
    expect(store.getRepos().map((repo) => repo.path)).toEqual([
      '/local/two',
      '/ssh/two',
      '/local/shared',
      '/ssh/shared'
    ])
  })

  it('reorderReposForHost rejects stale or duplicate host permutations without mutation', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-one', path: '/local/one' }))
    store.addRepo(makeRepo({ id: 'local-two', path: '/local/two' }))
    store.addRepo(
      makeRepo({
        id: 'ssh-one',
        path: '/ssh/one',
        connectionId: 'target',
        executionHostId: 'ssh:target'
      })
    )
    const originalPaths = store.getRepos().map((repo) => repo.path)

    expect(store.reorderReposForHost(['local-two'], 'local')).toBe(false)
    expect(store.reorderReposForHost(['local-one', 'local-one'], 'local')).toBe(false)
    expect(store.reorderReposForHost(['missing', 'local-two'], 'local')).toBe(false)
    expect(store.getRepos().map((repo) => repo.path)).toEqual(originalPaths)
  })

  it('removeProjectForHost prunes the SSH host meta (tagged hostId) for a shared id', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/remote/repo',
        connectionId: 'ssh-old',
        executionHostId: 'ssh:ssh-old'
      })
    )
    // SSH worktree meta correctly carries hostId (the normal, stamped case).
    store.setWorktreeMeta('shared::/remote/repo/wt', {
      displayName: 'remote-wt',
      hostId: 'ssh:ssh-old'
    })
    // A hostId-less meta is treated as local and left behind (never delete the wrong host's meta).
    store.setWorktreeMeta('shared::/local/repo/wt', { displayName: 'local-wt' })

    store.removeProjectForHost('shared', 'ssh:ssh-old')

    expect(store.getWorktreeMeta('shared::/remote/repo/wt')).toBeUndefined()
    expect(store.getWorktreeMeta('shared::/local/repo/wt')).toBeDefined()
  })

  it('removeProjectForHost prunes everything when the id exists on no other host', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'only', connectionId: 'ssh-x', executionHostId: 'ssh:ssh-x' }))
    store.setWorktreeMeta('only::/repo/wt', { displayName: 'wt', hostId: 'ssh:ssh-x' })

    store.removeProjectForHost('only', 'ssh:ssh-x')

    expect(store.getRepo('only')).toBeUndefined()
    expect(store.getWorktreeMeta('only::/repo/wt')).toBeUndefined()
  })

  // ── 6c. reassignSshTargetId re-adopts orphaned workspaces ─────────────

  it('reassignSshTargetId re-points repos and worktree metas onto the new id', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', connectionId: 'ssh-old', executionHostId: 'ssh:ssh-old' }))
    store.setWorktreeMeta('r1::/repo/wt', { displayName: 'wt', hostId: 'ssh:ssh-old' })

    const repoIds = store.reassignSshTargetId('ssh-old', 'ssh-new')

    expect(repoIds).toEqual(['r1'])
    const repo = store.getRepo('r1')!
    expect(repo.connectionId).toBe('ssh-new')
    expect(repo.executionHostId).toBe('ssh:ssh-new')
    expect(store.getWorktreeMeta('r1::/repo/wt')!.hostId).toBe('ssh:ssh-new')
  })

  it('reassignSshTargetId leaves repos on other hosts untouched', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'local-repo', path: '/local' }))
    store.addRepo(
      makeRepo({
        id: 'ssh-repo',
        path: '/remote',
        connectionId: 'ssh-old',
        executionHostId: 'ssh:ssh-old'
      })
    )

    const repoIds = store.reassignSshTargetId('ssh-old', 'ssh-new')

    expect(repoIds).toEqual(['ssh-repo'])
    expect(store.getRepo('local-repo')!.connectionId).toBeUndefined()
    expect(store.getRepo('ssh-repo')!.connectionId).toBe('ssh-new')
  })

  it('reassignSshTargetId re-points a repo that only carries connectionId (no executionHostId)', async () => {
    const store = await createStore()
    // SSH repos created via addRemoteRepoFromPath leave executionHostId unset.
    store.addRepo(makeRepo({ id: 'r1', connectionId: 'ssh-old' }))

    const repoIds = store.reassignSshTargetId('ssh-old', 'ssh-new')

    expect(repoIds).toEqual(['r1'])
    const repo = store.getRepo('r1')!
    expect(repo.connectionId).toBe('ssh-new')
    // Must not stamp an executionHostId where there wasn't one.
    expect(repo.executionHostId).toBeUndefined()
  })

  it('reassignSshTargetId persists a worktree-meta-only re-point (no matching repo)', async () => {
    const store = await createStore()
    // A meta on the old SSH host with no repo row — the re-point must still be persisted, not memory-only.
    store.setWorktreeMeta('r1::/remote/wt', { displayName: 'wt', hostId: 'ssh:ssh-old' })

    const repoIds = store.reassignSshTargetId('ssh-old', 'ssh-new')
    expect(repoIds).toEqual([]) // no repo matched
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getWorktreeMeta('r1::/remote/wt')?.hostId).toBe('ssh:ssh-new')
  })

  it('reassignSshTargetId migrates session pty ids, reconnect list, leases, and host scope', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', connectionId: 'ssh-old', executionHostId: 'ssh:ssh-old' }))
    store.setWorkspaceSession({
      activeRepoId: 'r1',
      activeWorktreeId: 'r1::/wt',
      activeTabId: 'tab1',
      tabsByWorktree: {
        'r1::/wt': [makeTerminalTab({ id: 'tab1', ptyId: 'ssh:ssh-old@@pty-2' })]
      },
      terminalLayoutsByTabId: {},
      remoteSessionIdsByTabId: { tab1: 'ssh:ssh-old@@pty-2' },
      activeConnectionIdsAtShutdown: ['ssh-old']
    })
    store.upsertSshRemotePtyLease({ targetId: 'ssh-old', ptyId: 'pty-2', state: 'detached' })
    store.updateUI({
      workspaceHostScope: 'ssh:ssh-old',
      visibleWorkspaceHostIds: ['local', 'ssh:ssh-old'],
      workspaceHostOrder: ['ssh:ssh-old', 'local']
    })

    store.reassignSshTargetId('ssh-old', 'ssh-new')
    store.flush()

    const reloaded = await createStore()
    const session = reloaded.getWorkspaceSession()
    expect(session.tabsByWorktree['r1::/wt'][0].ptyId).toBe('ssh:ssh-new@@pty-2')
    expect(session.remoteSessionIdsByTabId).toEqual({ tab1: 'ssh:ssh-new@@pty-2' })
    expect(session.activeConnectionIdsAtShutdown).toEqual(['ssh-new'])
    expect(reloaded.getSshRemotePtyLeases('ssh-new')).toHaveLength(1)
    expect(reloaded.getSshRemotePtyLeases('ssh-old')).toHaveLength(0)
    const ui = reloaded.getUI()
    expect(ui.workspaceHostScope).toBe('ssh:ssh-new')
    expect(ui.visibleWorkspaceHostIds).toEqual(['local', 'ssh:ssh-new'])
    expect(ui.workspaceHostOrder).toEqual(['ssh:ssh-new', 'local'])
  })

  it('reassignSshTargetId re-keys a session partition stored under the old ssh host id', async () => {
    const store = await createStore()
    store.setWorkspaceSession(
      {
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {
          'r1::/wt': [makeTerminalTab({ id: 'tab1', ptyId: 'ssh:ssh-old@@pty-9' })]
        },
        terminalLayoutsByTabId: {}
      },
      'ssh:ssh-old'
    )

    store.reassignSshTargetId('ssh-old', 'ssh-new')
    store.flush()

    const reloaded = await createStore()
    // Old-key partition is gone; the re-keyed one carries migrated pty ids.
    expect(reloaded.getWorkspaceSession('ssh:ssh-old').tabsByWorktree).toEqual({})
    expect(reloaded.getWorkspaceSession('ssh:ssh-new').tabsByWorktree['r1::/wt'][0].ptyId).toBe(
      'ssh:ssh-new@@pty-9'
    )
  })

  it('reassignSshTargetId keeps the live partition when both host keys exist', async () => {
    const store = await createStore()
    const baseSession = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      terminalLayoutsByTabId: {}
    }
    store.setWorkspaceSession(
      { ...baseSession, tabsByWorktree: { 'r1::/dead': [] } },
      'ssh:ssh-old'
    )
    store.setWorkspaceSession(
      { ...baseSession, tabsByWorktree: { 'r1::/live': [] } },
      'ssh:ssh-new'
    )

    store.reassignSshTargetId('ssh-old', 'ssh-new')

    expect(store.getWorkspaceSession('ssh:ssh-old').tabsByWorktree).toEqual({})
    expect(store.getWorkspaceSession('ssh:ssh-new').tabsByWorktree).toEqual({ 'r1::/live': [] })
  })

  it('reassignSshTargetId re-points an independent provisioned host setup', async () => {
    const store = await createStore()
    store.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })
    store.createProjectHostSetup({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'ssh:ssh-old',
      setupId: 'cloud-project::ssh-old',
      setupMethod: 'provisioned'
    })

    // Meta-only re-adoption must still migrate the provisioned setup, or new worktrees would be born on a dead host id.
    store.reassignSshTargetId('ssh-old', 'ssh-new')

    const setups = store.getProjectHostSetups()
    const provisioned = setups.find((entry) => entry.id === 'cloud-project::ssh-old')
    expect(provisioned?.hostId).toBe('ssh:ssh-new')
  })

  it('reassignSshTargetId drops a stale setup when the new host already has one', async () => {
    const store = await createStore()
    store.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })
    store.createProjectHostSetup({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'ssh:ssh-old',
      setupId: 'setup-old',
      setupMethod: 'provisioned'
    })
    store.createProjectHostSetup({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'ssh:ssh-new',
      setupId: 'setup-new',
      setupMethod: 'provisioned'
    })

    store.reassignSshTargetId('ssh-old', 'ssh-new')

    const setups = store.getProjectHostSetups()
    expect(setups.find((entry) => entry.id === 'setup-old')).toBeUndefined()
    expect(setups.find((entry) => entry.id === 'setup-new')?.hostId).toBe('ssh:ssh-new')
  })
})
