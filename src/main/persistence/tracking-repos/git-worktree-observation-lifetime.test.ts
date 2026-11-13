import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { stripOrcaProvenanceMetaUpdates } from '../../workspaces/removal/worktree-removal-safety'
import {
  closeTestStores,
  createStore,
  makeProject,
  makeProjectHostSetup,
  makeRepo,
  readPersistedState,
  testState,
  withPlatform,
  writeDataFile
} from '../persistence-test-harness'

vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(plaintext),
    decryptString: (ciphertext: Buffer) => ciphertext.toString()
  }
}))

const observation = { isBare: true, isMainWorktree: true, branch: '', prunable: false }
const local = hostWorktreeTarget({ id: 'r1::/repo', hostId: 'local' })
const foreign = hostWorktreeTarget({ id: 'r1::/repo', hostId: 'ssh:server' })
const metadata: WorktreeMeta = {
  displayName: 'Saved bare',
  comment: 'Keep my notes',
  linkedIssue: null,
  linkedPR: 42,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: true,
  sortOrder: 7,
  lastActivityAt: 0,
  instanceId: 'original',
  hostId: 'local'
}

function seedRepos(): void {
  writeDataFile({
    ...getDefaultPersistedState(testState.dir),
    repos: [makeRepo(), makeRepo({ executionHostId: 'ssh:server', connectionId: 'server' })]
  })
}

describe('host-owned Git observation persistence and lifetime', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-git-observation-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('normalizes whole saved observations without classifying invalid or missing facts', async () => {
    writeDataFile({
      ...getDefaultPersistedState(testState.dir),
      repos: [makeRepo()],
      worktreeMeta: {
        [local.id]: { ...metadata, gitWorktree: { ...observation, unexpected: 'drop' } },
        'r1::/invalid': {
          ...metadata,
          instanceId: 'invalid',
          gitWorktree: { ...observation, branch: 8 }
        },
        'r1::/legacy': { ...metadata, instanceId: 'legacy' }
      },
      worktreeMetaByIdentity: {
        'wt2:local:canonical': {
          ...metadata,
          instanceId: 'canonical',
          gitWorktree: { ...observation, prunable: 'no' }
        }
      },
      worktreeIdentityAliases: { 'local|r1::/canonical': ['wt2:local:canonical'] }
    })
    const store = createStore()
    expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toEqual(observation)
    expect(store.getWorktreeMetaForHost('r1::/invalid', 'local')?.gitWorktree).toBeUndefined()
    expect(store.getWorktreeMetaForHost('r1::/legacy', 'local')?.gitWorktree).toBeUndefined()
    expect(store.getWorktreeMetaForHost('r1::/canonical', 'local')?.gitWorktree).toBeUndefined()
    store.setWorktreeMeta(local, { comment: 'Edited after load' })
    store.flushOrThrow()
    await closeTestStores()
    const reloaded = createStore()
    expect(reloaded.getWorktreeMetaForHost(local.id, 'local')).toMatchObject({
      comment: 'Edited after load',
      gitWorktree: observation
    })
    expect(reloaded.getWorktreeMetaForHost('r1::/invalid', 'local')?.gitWorktree).toBeUndefined()
    expect(reloaded.getWorktreeMetaForHost('r1::/canonical', 'local')?.gitWorktree).toBeUndefined()
  })

  it('rejects client setting and clearing, preserves a move, and retires only facts on replacement', async () => {
    seedRepos()
    const store = createStore()
    store.setWorktreeMeta(local, { ...metadata, gitWorktree: observation, orcaCreatedAt: 123 })
    for (const clientPatch of [
      { gitWorktree: { ...observation, isBare: false }, orcaCreatedAt: 999 },
      { gitWorktree: undefined, orcaCreatedAt: undefined }
    ]) {
      const sanitized = stripOrcaProvenanceMetaUpdates({ ...clientPatch, comment: 'Client note' })
      expect(sanitized).toEqual({ comment: 'Client note' })
      store.setWorktreeMeta(local, sanitized)
    }
    store.flushOrThrow()
    await closeTestStores()
    const reloaded = createStore()
    expect(reloaded.getWorktreeMetaForHost(local.id, 'local')).toMatchObject({
      gitWorktree: observation,
      orcaCreatedAt: 123,
      comment: 'Client note',
      linkedPR: 42
    })
    const moved = hostWorktreeTarget({ id: 'r1::/renamed', hostId: 'local' })
    reloaded.migrateWorktreeIdentity(local, moved.id)
    expect(reloaded.getWorktreeMetaForHost(moved.id, 'local')).toMatchObject({
      instanceId: 'original',
      gitWorktree: observation
    })
    reloaded.setWorktreeMeta(moved, { instanceId: 'replacement' })
    expect(reloaded.getWorktreeMetaForHost(moved.id, 'local')).toMatchObject({
      instanceId: 'replacement',
      displayName: 'Saved bare',
      comment: 'Client note',
      linkedPR: 42,
      isPinned: true
    })
    expect(reloaded.getWorktreeMetaForHost(moved.id, 'local')?.gitWorktree).toBeUndefined()
    reloaded.flushOrThrow()
    await closeTestStores()
    const finalStore = createStore()
    expect(finalStore.getWorktreeMetaForHost(moved.id, 'local')?.gitWorktree).toBeUndefined()
  })

  it('retires local inherited-default and project execution changes, preserving equivalent policy and remote twins', async () => {
    await withPlatform('win32', async () => {
      seedRepos()
      const store = createStore()
      store.addRepo(makeRepo({ id: 'r2', path: '/other' }))
      const projectId = store
        .getProjects()
        .find((project) => project.sourceRepoIds.includes('r1'))?.id
      const explicitId = store
        .getProjects()
        .find((project) => project.sourceRepoIds.includes('r2'))?.id
      if (!projectId || !explicitId) {
        throw new Error('Expected real repo-backed projects')
      }
      store.updateProject(explicitId, { localWindowsRuntimePreference: { kind: 'windows-host' } })
      const explicit = hostWorktreeTarget({ id: 'r2::/other', hostId: 'local' })
      for (const target of [local, foreign, explicit]) {
        store.setWorktreeMeta(target, { comment: 'Keep this', gitWorktree: observation })
      }
      store.updateProject(projectId, { localWindowsRuntimePreference: { kind: 'windows-host' } })
      store.updateProject(projectId, { localWindowsRuntimePreference: undefined })
      store.updateRepo({ id: 'r1' }, { displayName: 'Renamed', externalWorktreeVisibility: 'hide' })
      expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toEqual(observation)
      store.updateSettings({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
      expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toBeUndefined()
      expect(store.getWorktreeMetaForHost(foreign.id, foreign.hostId)?.gitWorktree).toEqual(
        observation
      )
      expect(store.getWorktreeMetaForHost(explicit.id, 'local')?.gitWorktree).toEqual(observation)
      store.setWorktreeMeta(local, { gitWorktree: observation })
      store.updateSettings({ localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } })
      expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toEqual(observation)
      store.updateProject(projectId, {
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' }
      })
      expect(store.getWorktreeMetaForHost(local.id, 'local')).toMatchObject({
        comment: 'Keep this'
      })
      expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toBeUndefined()
      store.flushOrThrow()
      await closeTestStores()
      const reloaded = createStore()
      expect(reloaded.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toBeUndefined()
      expect(reloaded.getWorktreeMetaForHost(foreign.id, foreign.hostId)?.gitWorktree).toEqual(
        observation
      )
      expect(readPersistedState().worktreeMeta[local.id]?.gitWorktree).toBeUndefined()
    })
  })

  it('retires repo host/kind and independent setup path/kind changes without losing metadata or sibling facts', async () => {
    seedRepos()
    const store = createStore()
    store.setWorktreeMeta(local, { ...metadata, gitWorktree: observation })
    store.setWorktreeMeta(foreign, { comment: 'Foreign notes', gitWorktree: observation })
    store.updateRepo(
      { id: 'r1' },
      { projectHostSetupMethod: 'cloned', worktreeBasePath: '/new-base' }
    )
    expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toEqual(observation)
    store.updateRepo({ id: 'r1' }, { kind: 'folder' })
    expect(store.getWorktreeMetaForHost(local.id, 'local')).toMatchObject({
      comment: 'Keep my notes',
      linkedPR: 42
    })
    expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toBeUndefined()
    expect(store.getWorktreeMetaForHost(foreign.id, foreign.hostId)?.gitWorktree).toEqual(
      observation
    )
    store.setWorktreeMeta(local, { gitWorktree: observation })
    store.updateRepo({ id: 'r1' }, { executionHostId: 'runtime:replacement' })
    expect(store.getWorktreeMetaForHost(local.id, 'local')?.gitWorktree).toBeUndefined()
    expect(store.getWorktreeMetaForHost(foreign.id, foreign.hostId)?.gitWorktree).toEqual(
      observation
    )

    const project = makeProject({ id: 'independent' })
    const setup = makeProjectHostSetup({ id: 'independent::local', projectId: project.id })
    await closeTestStores()
    const saved = readPersistedState()
    writeDataFile({
      ...saved,
      projects: [...saved.projects, project],
      projectHostSetups: [...saved.projectHostSetups, setup]
    })
    const reopened = createStore()
    const independent = hostWorktreeTarget({ id: 'independent::/repo', hostId: 'local' })
    reopened.setWorktreeMeta(independent, {
      comment: 'Independent notes',
      projectId: project.id,
      projectHostSetupId: setup.id,
      gitWorktree: observation
    })
    reopened.updateProjectHostSetup({
      setupId: setup.id,
      updates: { displayName: 'New label', setupState: 'error' }
    })
    expect(reopened.getWorktreeMetaForHost(independent.id, 'local')?.gitWorktree).toEqual(
      observation
    )
    reopened.updateProjectHostSetup({ setupId: setup.id, updates: { path: '/new-location' } })
    expect(reopened.getWorktreeMetaForHost(independent.id, 'local')?.gitWorktree).toBeUndefined()
    reopened.setWorktreeMeta(independent, { gitWorktree: observation })
    reopened.updateProjectHostSetup({ setupId: setup.id, updates: { kind: 'folder' } })
    expect(reopened.getWorktreeMetaForHost(independent.id, 'local')).toMatchObject({
      comment: 'Independent notes'
    })
    expect(reopened.getWorktreeMetaForHost(independent.id, 'local')?.gitWorktree).toBeUndefined()
    reopened.flushOrThrow()
    await closeTestStores()
    expect(
      createStore().getWorktreeMetaForHost(independent.id, 'local')?.gitWorktree
    ).toBeUndefined()
  })
})
