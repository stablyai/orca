import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../shared/constants'
import {
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeProject,
  makeProjectHostSetup
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
  // ── 7. updateRepo ──────────────────────────────────────────────────

  it('updateRepo modifies the repo in place', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { displayName: 'renamed' })
    expect(updated).not.toBeNull()
    expect(updated!.displayName).toBe('renamed')
    expect(store.getRepo('r1')!.displayName).toBe('renamed')
  })

  it('updateRepo targets one host when repo ids collide', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'shared', path: '/local/repo' }))
    store.addRepo(
      makeRepo({
        id: 'shared',
        path: '/remote/repo',
        connectionId: 'server',
        executionHostId: 'ssh:server'
      })
    )

    const updated = store.updateRepo('shared', { displayName: 'Remote renamed' }, 'ssh:server')

    expect(updated?.path).toBe('/remote/repo')
    expect(store.getRepos().filter((repo) => repo.id === 'shared')).toMatchObject([
      { path: '/local/repo', displayName: 'test' },
      { path: '/remote/repo', displayName: 'Remote renamed' }
    ])
  })

  it('updateRepo keeps project host setup compatibility records in sync', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ worktreeBasePath: '../worktrees' }))

    store.updateRepo('r1', {
      displayName: 'renamed',
      worktreeBasePath: '../new-worktrees',
      upstream: { owner: 'stablyai', repo: 'orca' }
    })

    expect(store.getProjects()).toEqual([
      expect.objectContaining({
        id: 'github:stablyai/orca',
        displayName: 'renamed',
        sourceRepoIds: ['r1']
      })
    ])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({
        id: 'r1',
        projectId: 'github:stablyai/orca',
        displayName: 'renamed',
        worktreeBasePath: '../new-worktrees'
      })
    ])
  })

  it('repo mutations preserve independent project host setup records', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ id: 'r1' })],
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })
    const store = await createStore()

    store.updateRepo('r1', { displayName: 'renamed' })
    store.reorderRepos(['r1'])

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r1', 'cloud-project'])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({ id: 'r1', displayName: 'renamed' }),
      independentSetup
    ])
  })

  it('updates independent project host setup records directly', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })
    const store = await createStore()

    const result = store.updateProjectHostSetup({
      setupId: independentSetup.id,
      updates: {
        displayName: 'GPU VM renamed',
        path: '/srv/renamed',
        worktreeBasePath: '../worktrees',
        setupState: 'ready',
        setupMethod: 'cloned',
        gitUsername: 'alice'
      }
    })

    expect(result).toEqual({
      project: independentProject,
      setup: expect.objectContaining({
        id: independentSetup.id,
        displayName: 'GPU VM renamed',
        path: '/srv/renamed',
        worktreeBasePath: '../worktrees',
        setupState: 'ready',
        setupMethod: 'cloned',
        gitUsername: 'alice'
      })
    })
    expect(store.getProjectHostSetups()[0]).toMatchObject({
      displayName: 'GPU VM renamed',
      path: '/srv/renamed'
    })
  })

  it('creates independent project host setup records for provisioning flows', async () => {
    const store = await createStore()
    store.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })

    const result = store.createProjectHostSetup({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm',
      setupId: 'cloud-project::gpu-vm',
      displayName: 'GPU VM',
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })

    expect(result?.project).toMatchObject({
      id: 'github:stablyai/cloud-project',
      displayName: 'Cloud Project'
    })
    expect(result?.setup).toMatchObject({
      id: 'cloud-project::gpu-vm',
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '',
      displayName: 'GPU VM',
      setupState: 'setting-up',
      setupMethod: 'provisioned'
    })
    expect(store.getRepos()).toHaveLength(1)
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({ id: 'r1', repoId: 'r1' }),
      result?.setup
    ])
  })

  it('rejects duplicate project host setup creation for the same host', async () => {
    const store = await createStore()
    store.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm'
    })
    store.createProjectHostSetup({
      projectId: independentSetup.projectId,
      hostId: independentSetup.hostId,
      setupId: independentSetup.id
    })

    expect(() =>
      store.createProjectHostSetup({
        projectId: 'github:stablyai/cloud-project',
        hostId: 'runtime:gpu-vm',
        setupId: 'duplicate'
      })
    ).toThrow('Project host setup already exists: cloud-project::gpu-vm')
  })

  it('updates repo-backed project host setup metadata through the repo record', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', displayName: 'Repo', worktreeBasePath: '../old' }))

    const result = store.updateProjectHostSetup({
      setupId: 'r1',
      updates: {
        displayName: 'Repo renamed',
        worktreeBasePath: '../new',
        setupMethod: 'cloned'
      }
    })

    expect(result?.repo).toMatchObject({
      id: 'r1',
      displayName: 'Repo renamed',
      worktreeBasePath: '../new',
      projectHostSetupMethod: 'cloned'
    })
    expect(result?.project).toMatchObject({
      id: 'repo:r1',
      displayName: 'Repo renamed'
    })
    expect(result?.setup).toMatchObject({
      id: 'r1',
      displayName: 'Repo renamed',
      worktreeBasePath: '../new',
      setupMethod: 'cloned'
    })
  })

  it('rejects repo-backed project host setup path changes', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))

    expect(() =>
      store.updateProjectHostSetup({
        setupId: 'r1',
        updates: { path: '/other' }
      })
    ).toThrow('Repo-backed project host setup paths must be changed by re-importing the project.')
  })

  it('deletes independent project host setup records without deleting the project', async () => {
    const independentProject = makeProject({
      id: 'cloud-project',
      displayName: 'Cloud Project'
    })
    const independentSetup = makeProjectHostSetup({
      id: 'cloud-project::gpu-vm',
      projectId: independentProject.id,
      hostId: 'runtime:gpu-vm',
      repoId: '',
      path: '/srv/cloud-project',
      displayName: 'GPU VM'
    })
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      projects: [independentProject],
      projectHostSetups: [independentSetup]
    })
    const store = await createStore()

    const result = store.deleteProjectHostSetup({ setupId: independentSetup.id })

    expect(result).toEqual({ project: independentProject, setup: independentSetup })
    expect(store.getProjects()).toEqual([independentProject])
    expect(store.getProjectHostSetups()).toEqual([])
  })

  it('deletes repo-backed project host setups by removing the compatibility repo', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo' }))
    store.setWorktreeMeta('r1::/path/wt1', { displayName: 'wt1' })

    const result = store.deleteProjectHostSetup({ setupId: 'r1' })

    expect(result?.project).toMatchObject({ id: 'repo:r1' })
    expect(result?.setup).toMatchObject({ id: 'r1', repoId: 'r1' })
    expect(result?.repo).toMatchObject({ id: 'r1' })
    expect(store.getRepo('r1')).toBeUndefined()
    expect(store.getProjects()).toEqual([])
    expect(store.getProjectHostSetups()).toEqual([])
    expect(store.getWorktreeMeta('r1::/path/wt1')).toBeUndefined()
  })

  it('updateRepo preserves repo-backed project host setup method', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    store.updateRepo('r1', { projectHostSetupMethod: 'cloned' })

    expect(store.getRepo('r1')?.projectHostSetupMethod).toBe('cloned')
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({
        id: 'r1',
        setupMethod: 'cloned'
      })
    ])
  })

  it('updateRepo drops repo icons that fail shared sanitization', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      repoIcon: {
        type: 'image',
        source: 'upload',
        src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
      } as never
    })

    expect(updated).not.toBeNull()
    expect(updated!.repoIcon).toBeUndefined()
    expect(store.getRepo('r1')!.repoIcon).toBeUndefined()
  })

  it('updateRepo normalizes custom repo badge colors before storing', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { badgeColor: ' ABCDEF ' })

    expect(updated!.badgeColor).toBe('#abcdef')
    expect(store.getRepo('r1')!.badgeColor).toBe('#abcdef')
  })

  it('updateRepo ignores invalid repo badge colors without clearing the existing color', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ badgeColor: '#123456' }))

    const updated = store.updateRepo('r1', { badgeColor: 'blue' })

    expect(updated!.badgeColor).toBe('#123456')
    expect(store.getRepo('r1')!.badgeColor).toBe('#123456')
  })

  it('getRepo does not expose invalid persisted repo icons', async () => {
    const store = await createStore()
    store.addRepo(
      makeRepo({
        repoIcon: {
          type: 'image',
          source: 'upload',
          src: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='
        } as never
      })
    )

    expect(store.getRepo('r1')!.repoIcon).toBeUndefined()
    expect(store.getRepos()[0]!.repoIcon).toBeUndefined()
  })

  it('updateRepo normalizes and persists repo upstream metadata', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      upstream: { owner: ' stablyai ', repo: ' orca ' }
    })
    expect(updated!.upstream).toEqual({ owner: 'stablyai', repo: 'orca' })

    store.updateRepo('r1', { upstream: null })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.upstream).toBeNull()
  })

  it('updateRepo persists the resolved no-usable-remote identity marker', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.example.com/team/orca',
        remoteName: 'origin',
        remoteUrl: 'git@gitlab.example.com:team/orca.git'
      }
    })
    expect(updated!.gitRemoteIdentity).toEqual({
      canonicalKey: 'gitlab.example.com/team/orca',
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.example.com:team/orca.git'
    })

    store.updateRepo('r1', { gitRemoteIdentity: null })
    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.gitRemoteIdentity).toBeNull()
  })

  it('getRepo does not expose invalid persisted repo upstream metadata', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: '', repo: 42 } as never }))

    expect(store.getRepo('r1')!.upstream).toBeUndefined()
    expect(store.getRepos()[0]!.upstream).toBeUndefined()
  })

  it('keeps the upstream host across reloads so it is never re-inferred from origin', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', {
      upstream: { owner: ' acme ', repo: ' widgets ', host: ' GHE.example:8443 ' }
    })
    expect(updated!.upstream).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'GHE.example:8443'
    })

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.upstream).toEqual({
      owner: 'acme',
      repo: 'widgets',
      host: 'GHE.example:8443'
    })
  })

  it('leaves a hostless persisted upstream hostless rather than inventing one', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'stablyai', repo: 'orca' } }))

    expect(store.getRepo('r1')!.upstream).toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(store.getRepo('r1')!.upstream).not.toHaveProperty('host')
  })

  it('drops a blank upstream host instead of persisting an empty string', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ upstream: { owner: 'acme', repo: 'widgets', host: '   ' } }))

    expect(store.getRepo('r1')!.upstream).toEqual({ owner: 'acme', repo: 'widgets' })
  })

  it('updateRepo returns null for nonexistent id', async () => {
    const store = await createStore()
    expect(store.updateRepo('nope', { displayName: 'x' })).toBeNull()
  })

  it('updateRepo persists issueSourcePreference across reloads', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { issueSourcePreference: 'upstream' })
    expect(updated!.issueSourcePreference).toBe('upstream')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBe('upstream')
  })

  it('updateRepo persists fork sync mode across reloads', async () => {
    const store = await createStore()
    store.addRepo(makeRepo())

    const updated = store.updateRepo('r1', { forkSyncMode: 'safe-auto' })
    expect(updated!.forkSyncMode).toBe('safe-auto')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.forkSyncMode).toBe('safe-auto')
  })

  it('updateRepo ignores invalid fork sync mode updates', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ forkSyncMode: 'ask' }))

    const updated = store.updateRepo('r1', { forkSyncMode: 'always' as never })

    expect(updated!.forkSyncMode).toBe('ask')

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.forkSyncMode).toBe('ask')
  })

  it('getRepo does not expose invalid persisted fork sync mode values', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo({ forkSyncMode: 'always' as never })]
    })

    const store = await createStore()

    expect(store.getRepo('r1')!.forkSyncMode).toBeUndefined()
    expect(store.getRepos()[0]!.forkSyncMode).toBeUndefined()
  })

  it('updateRepo with issueSourcePreference=undefined clears the preference', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ issueSourcePreference: 'origin' }))
    expect(store.getRepo('r1')!.issueSourcePreference).toBe('origin')

    // Why: `Object.assign` skips undefined, so updateRepo needs an explicit delete branch or the key with value undefined wouldn't clear.
    store.updateRepo('r1', { issueSourcePreference: undefined })
    expect(store.getRepo('r1')!.issueSourcePreference).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('r1')!.issueSourcePreference).toBeUndefined()
  })
})
