import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo,
  makeProject,
  makeProjectHostSetup
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import '../../workspaces/catalog/folder-repo-git-conversion'
import '../../../shared/worktree/host-qualified-identity'
import '../host-qualified-worktree-meta'
import '../../runtime/workspaces/catalog/worktree-catalog-live-route'
import '../../runtime/workspaces/catalog/runtime-worktree-scan-cache'
import '../../workspaces/catalog/repo-worktree-catalog-route'

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

    const updated = store.updateRepo(
      { id: 'shared', executionHostId: 'ssh:server' },
      { displayName: 'Remote renamed' }
    )

    expect(updated?.path).toBe('/remote/repo')
    expect(store.getRepos().filter((repo) => repo.id === 'shared')).toMatchObject([
      { path: '/local/repo', displayName: 'test' },
      { path: '/remote/repo', displayName: 'Remote renamed' }
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

    store.updateRepo({ id: 'r1' }, { displayName: 'renamed' })
    store.reorderRepos(['r1'])

    expect(store.getProjects().map((project) => project.id)).toEqual(['repo:r1', 'cloud-project'])
    expect(store.getProjectHostSetups()).toEqual([
      expect.objectContaining({ id: 'r1', displayName: 'renamed' }),
      independentSetup
    ])
  })

  // Git catalogs cannot enumerate sibling folder workspaces; changing kind would strand their tabs (STA-10638).

  // Git accepts subdirectories; conversion must separately prove this folder is the checkout root.
})
