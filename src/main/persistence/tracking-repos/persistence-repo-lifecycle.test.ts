import {
  closeTestStores,
  testState,
  createStore,
  readDataFile,
  makeRepo
} from '../persistence-test-harness'
import { makeTerminalTab } from '../persistence-session-fixtures'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { _getLocalWorktreeScanGenerationCacheSize } from '../../workspaces/catalog/local-worktree-scan-generation'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { _pendingWslStoppedWorktreeRescanCount } from '../../wsl/discovery/wsl-stopped-worktree-rescan-registry'
import type { ExecutionHostId } from '../../../shared/execution-host'

const at = (id: string, hostId: ExecutionHostId) => hostWorktreeTarget({ id, hostId })
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('removeProjectForHost removes only the target host row for a shared repo id', async () => {
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
    store.setWorktreeMeta(at('shared::/local/repo/wt', 'local'), { displayName: 'local-wt' })
    store.setWorktreeMeta(at('shared::/remote/repo/wt', 'ssh:ssh-old'), {
      displayName: 'remote-wt'
    })

    store.removeProjectForHost({ id: 'shared', executionHostId: 'ssh:ssh-old' })

    const remaining = store.getRepos().filter((r) => r.id === 'shared')
    expect(remaining).toHaveLength(1)
    expect(remaining[0].path).toBe('/local/repo')
    expect(store.getWorktreeMeta('shared::/local/repo/wt')).toBeDefined()
    expect(store.getWorktreeMeta('shared::/remote/repo/wt')).toBeUndefined()
    store.flush()
    const persisted = readDataFile() as PersistedState
    const identityMetadata = Object.values(persisted.worktreeMetaByIdentity ?? {})
    expect(identityMetadata).toEqual([
      expect.objectContaining({ hostId: 'local', displayName: 'local-wt' })
    ])
  })

  it('removing a project saves the repo, metadata and session removal with only those domains dirty', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))
    store.setWorktreeMeta(at('r1::/repo/wt', 'local'), { displayName: 'wt' })
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { 'r1::/repo/wt': 111 }
    })
    // Drain earlier saves so the removal's own save is the one under test.
    store.flush()

    store.removeProjectForHost({ id: 'r1', executionHostId: 'local' })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getRepos()).toEqual([])
    expect(reloaded.getWorktreeMeta('r1::/repo/wt')).toBeUndefined()
    expect(
      reloaded.getWorkspaceSession().lastVisitedAtByWorktreeId?.['r1::/repo/wt']
    ).toBeUndefined()
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
    store.setWorktreeMeta(at('shared::/repo', 'local'), { displayName: 'local' })

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

    store.removeProjectForHost({ id: 'shared', executionHostId: 'local' })

    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.['shared::/repo']).toBeUndefined()
    expect(
      store.getWorkspaceSession('ssh:ssh-a').lastVisitedAtByWorktreeId?.['shared::/repo']
    ).toBe(222)
  })

  it('removeProjectForHost prunes only the removed host when a third host also shares the owner key', async () => {
    const store = await createStore()
    // Three hosts share the same worktree ID; removing one must preserve both survivors.
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
    store.setWorktreeMeta(at('shared::/repo', 'local'), { displayName: 'local' })

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

    store.removeProjectForHost({ id: 'shared', executionHostId: 'ssh:ssh-a' })

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

  it('reassignSshTargetId persists a worktree-meta-only re-point (no matching repo)', async () => {
    const store = await createStore()
    // Register the repo locally so orphan cleanup cannot mask metadata-only remote re-adoption.
    store.addRepo(makeRepo({ id: 'r1', path: '/r1' }))
    store.setWorktreeMeta(at('r1::/remote/wt', 'ssh:ssh-old'), { displayName: 'wt' })

    const repoIds = store.reassignSshTargetId('ssh-old', 'ssh-new')
    expect(repoIds).toEqual([])
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getWorktreeMeta('r1::/remote/wt')?.hostId).toBe('ssh:ssh-new')
  })

  it('reassignSshTargetId re-keys a session partition stored under the old ssh host id', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/r1' }))
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
