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
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  commitProvenRepoKindChange,
  updateProjectHostSetupWithProvenKind
} from '../../workspaces/catalog/folder-repo-git-conversion'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { removeWorktreeMetaRow } from '../host-qualified-worktree-meta'
import { registerWorktreeCatalogRoutes } from '../../runtime/workspaces/catalog/worktree-catalog-live-route'
import { resolveWorktreeScanRuntime } from '../../runtime/workspaces/catalog/runtime-worktree-scan-cache'
import {
  isLiveWorktreeCatalogRoute,
  setWorktreeCatalogRouteResolver
} from '../../workspaces/catalog/repo-worktree-catalog-route'

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

  it('persists a project default with independent setup creation', async () => {
    const initial = createStore()
    initial.addRepo({
      ...makeRepo({ id: 'r1', displayName: 'Cloud Project' }),
      upstream: { owner: 'stablyai', repo: 'cloud-project' }
    })
    await initial.flushPendingOrThrowAsync()
    await closeTestStores()

    const store = createStore()
    await store.flushPendingOrThrowAsync()
    store.createProjectHostSetup({
      projectId: 'github:stablyai/cloud-project',
      hostId: 'runtime:gpu-vm',
      defaultTuiAgent: 'codex'
    })
    await store.flushPendingOrThrowAsync()
    await closeTestStores()

    const reopened = createStore()
    expect(reopened.getProjects()).toContainEqual(
      expect.objectContaining({
        id: 'github:stablyai/cloud-project',
        defaultTuiAgent: 'codex'
      })
    )
    expect(reopened.getProjectHostSetups()).toContainEqual(
      expect.objectContaining({
        projectId: 'github:stablyai/cloud-project',
        hostId: 'runtime:gpu-vm'
      })
    )

    reopened.updateProject('github:stablyai/cloud-project', { defaultTuiAgent: 'blank' })
    await reopened.flushPendingOrThrowAsync()
    await closeTestStores()
    const blank = createStore()
    expect(blank.getProjects()).toContainEqual(
      expect.objectContaining({ id: 'github:stablyai/cloud-project', defaultTuiAgent: 'blank' })
    )

    blank.updateProject('github:stablyai/cloud-project', { defaultTuiAgent: null })
    await blank.flushPendingOrThrowAsync()
    await closeTestStores()
    expect(createStore().getProjects()).toContainEqual(
      expect.objectContaining({ id: 'github:stablyai/cloud-project', defaultTuiAgent: null })
    )
  })

  it("revokes a repo's local Git catalog route as soon as its registration is removed", async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/local/repo' }))
    registerWorktreeCatalogRoutes(store as never)
    try {
      const repo = store.getRepos()[0]
      const route = {
        repoPath: '/local/repo',
        runtimeKey: resolveWorktreeScanRuntime(store as never, repo).runtimeKey
      }
      expect(isLiveWorktreeCatalogRoute('r1', 'local', route)).toBe(true)

      store.removeProjectForHost({ id: 'r1' })

      expect(isLiveWorktreeCatalogRoute('r1', 'local', route)).toBe(false)
    } finally {
      setWorktreeCatalogRouteResolver(null)
    }
  })

  it('admits a folder converted to Git as a local Git route as soon as the write lands', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/local/folder', kind: 'folder' }))
    registerWorktreeCatalogRoutes(store as never)
    try {
      const routeFor = () => ({
        repoPath: '/local/folder',
        runtimeKey: resolveWorktreeScanRuntime(store as never, store.getRepos()[0]).runtimeKey
      })
      expect(isLiveWorktreeCatalogRoute('r1', 'local', routeFor())).toBe(false)

      store.updateRepo({ id: 'r1' }, { kind: 'git', folderUpgradeGitRootPath: '/local/folder' })

      expect(store.getRepos()[0]?.kind).toBe('git')
      expect(isLiveWorktreeCatalogRoute('r1', 'local', routeFor())).toBe(true)
    } finally {
      setWorktreeCatalogRouteResolver(null)
    }
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
  it('refuses a folder-to-Git type change while the project has other folder workspaces', async () => {
    const store = await createStore()
    store.addRepo(makeRepo({ id: 'r1', path: '/repo', kind: 'folder', displayName: 'Repo' }))
    const workspaceId = 'r1::/repo::workspace:11111111-1111-4111-8111-111111111111'
    store.setWorktreeMeta(hostWorktreeTarget({ id: workspaceId, hostId: 'local' }), {
      displayName: 'Second workspace'
    })

    expect(() =>
      store.updateProjectHostSetup({
        setupId: 'r1',
        updates: { kind: 'git', displayName: 'Renamed' }
      })
    ).toThrow("This folder project has 1 other workspace that a Git project can't show")
    expect(store.getRepo('r1')).toMatchObject({ kind: 'folder', displayName: 'Repo' })

    removeWorktreeMetaRow(store, workspaceId, undefined)
    expect(
      store.updateProjectHostSetup({ setupId: 'r1', updates: { kind: 'git' } })?.repo
    ).toMatchObject({ kind: 'git' })
  })

  // Git accepts subdirectories; conversion must separately prove this folder is the checkout root.
  it('proves a manual folder-to-Git change against the Git root before writing it', async () => {
    const store = await createStore()
    const root = join(testState.dir, 'project')
    mkdirSync(join(root, 'sub'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: root })
    store.addRepo(makeRepo({ id: 'inner', path: join(root, 'sub'), kind: 'folder' }))
    store.addRepo(makeRepo({ id: 'outer', path: root, kind: 'folder' }))
    const changeToGit = (setupId: string) =>
      updateProjectHostSetupWithProvenKind(store, (args) => store.updateProjectHostSetup(args), {
        setupId,
        updates: { kind: 'git' }
      })

    await expect(changeToGit('inner')).rejects.toThrow("isn't the top folder of a Git repository")
    expect(store.getRepo('inner')?.kind).toBe('folder')
    const converted = await changeToGit('outer')
    expect(converted?.repo).toMatchObject({
      kind: 'git',
      folderUpgradeGitRootPath: expect.any(String)
    })
  })

  it('refuses a proven conversion if the selected folder path changed before commit', async () => {
    const root = join(testState.dir, 'moved-project')
    mkdirSync(root, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: root })
    const repo = makeRepo({ id: 'moving-folder', path: root, kind: 'folder' })
    const write = vi.fn()
    await expect(
      commitProvenRepoKindChange(
        { getRepos: () => [{ ...repo, path: join(root, 'new-path') }] },
        repo,
        write
      )
    ).rejects.toThrow('The project changed while Orca was checking it')
    expect(write).not.toHaveBeenCalled()
  })
})
