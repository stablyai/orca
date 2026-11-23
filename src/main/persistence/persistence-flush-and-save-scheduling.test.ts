import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createSqliteTestStore,
  testState,
  createStore,
  withPlatform,
  writeDataFile,
  makeRepo,
  readPersistedStateJson
} from './persistence-test-harness'
import './persistence-session-fixtures'
import '../../shared/orca-profiles/constants'
import type { PersistedState } from '../../shared/orca-profiles/persisted-state-types'

import '../observability/tracer'
import { _resetPtyBindingSpanSamplingForTests } from './loading-store/terminal-bindings/pty-binding-span'

import { preserveStateBeforeUpdateRestart } from '../core-desktop/update-restart-preservation'
import { ProfileStateSqliteAuthority } from './profile-state/profile-state-sqlite-authority'

type PrCacheEntry = PersistedState['githubCache']['pr'][string]

// Omit `data` so the reload assertions compare exactly the fetchedAt each profile persisted.
function dataLessPrCacheEntry(fetchedAt: number): PrCacheEntry {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store persists cache entries opaquely and never reads `data` on this path; the reload assertions require the field to stay absent.
  return { fetchedAt } as PrCacheEntry
}

const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('../ssh/config/ssh-config-parser', () => ({
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

vi.mock('../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../telemetry/cohort-classifier', () => ({
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
    vi.restoreAllMocks()
    _resetPtyBindingSpanSamplingForTests()
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('garbage-collects stale local worktreeMeta at load with a 30-day grace', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const RECENT = Date.now() - 1 * 24 * 60 * 60 * 1000
    const missing = (name: string): string => join(testState.dir, 'gone', name)
    const meta = (lastActivityAt: number, extra: Record<string, unknown> = {}) => ({
      displayName: '',
      comment: '',
      lastActivityAt,
      ...extra
    })
    const liveKey = `r1::${testState.dir}`
    const deadKey = `r1::${missing('dead')}`
    const recentKey = `r1::${missing('recent')}`
    const sshKey = `ssh-repo::/home/alice/gone`
    const remoteHostKey = `r1::${missing('remote-host')}`
    const orphanKey = `removed-repo::${missing('orphan')}`
    const wslKey = `r1::\\\\wsl$\\Ubuntu\\home\\gone`

    writeDataFile({
      repos: [
        makeRepo(),
        makeRepo({ id: 'ssh-repo', path: '/home/alice/repo', connectionId: 'conn-1' })
      ],
      worktreeMeta: {
        [liveKey]: meta(OLD),
        [deadKey]: meta(OLD),
        [recentKey]: meta(RECENT),
        [sshKey]: meta(OLD),
        [remoteHostKey]: meta(OLD, { hostId: 'ssh:conn-1' }),
        [orphanKey]: meta(OLD),
        [wslKey]: meta(OLD)
      },
      worktreeLineageById: { [deadKey]: { parentWorktreeId: liveKey } }
    })

    const store = await createStore()
    const kept = Object.keys(store.getAllWorktreeMeta())

    expect(kept).toContain(liveKey)
    expect(kept).toContain(recentKey)
    expect(kept).toContain(sshKey)
    expect(kept).toContain(remoteHostKey)
    expect(kept).toContain(wslKey)
    expect(kept).not.toContain(deadKey)
    expect(kept).not.toContain(orphanKey)
    expect(store.getWorktreeLineage(deadKey)).toBeUndefined()
  })

  it('never GCs folder-workspace instance metas — the meta IS the workspace', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const folderInstanceKey = `r1::${join(testState.dir, 'gone-folder')}::workspace:11111111-1111-4111-8111-111111111111`
    writeDataFile({
      repos: [makeRepo({ kind: 'folder' })],
      worktreeMeta: {
        [folderInstanceKey]: { displayName: 'Session A', comment: '', lastActivityAt: OLD }
      }
    })

    const store = await createStore()
    expect(Object.keys(store.getAllWorktreeMeta())).toContain(folderInstanceKey)
  })

  it('never GCs Linux-style WSL worktree paths on Windows', async () => {
    const OLD = Date.now() - 40 * 24 * 60 * 60 * 1000
    const wslLinkedKey = 'r1::/home/user/gone-worktree'
    writeDataFile({
      repos: [makeRepo()],
      worktreeMeta: {
        [wslLinkedKey]: { displayName: '', comment: '', lastActivityAt: OLD }
      }
    })

    await withPlatform('win32', async () => {
      const store = await createStore()
      expect(Object.keys(store.getAllWorktreeMeta())).toContain(wslLinkedKey)
    })
  })

  it('can prepare an update while live state changes and still saves the change on quit', async () => {
    const store = createStore()
    store.updateUI({ lastUpdateCheckAt: 100 })
    const write = ProfileStateSqliteAuthority.prototype.writeCompleteSerializedDomains
    vi.spyOn(
      ProfileStateSqliteAuthority.prototype,
      'writeCompleteSerializedDomains'
    ).mockImplementationOnce(function (this: ProfileStateSqliteAuthority, ...args) {
      write.apply(this, args)
      store.updateUI({ lastUpdateCheckAt: 200 })
    })

    await preserveStateBeforeUpdateRestart({ codexRuntimeHome: null, store })

    expect(JSON.parse(readPersistedStateJson())).toHaveProperty('ui.lastUpdateCheckAt', 100)
    await store.flushFinalOrThrowAsync()
    expect(JSON.parse(readPersistedStateJson())).toHaveProperty('ui.lastUpdateCheckAt', 200)
  })

  it('refuses update preparation when the profile cannot be written', async () => {
    const store = createStore()
    store.updateUI({ lastUpdateCheckAt: 100 })
    vi.spyOn(
      ProfileStateSqliteAuthority.prototype,
      'writeCompleteSerializedDomains'
    ).mockImplementationOnce(() => {
      throw new Error('profile disk is read-only')
    })

    await expect(
      preserveStateBeforeUpdateRestart({ codexRuntimeHome: null, store })
    ).rejects.toThrow('profile disk is read-only')
  })

  it('keeps the GitHub cache scoped to explicit profile data files', async () => {
    const profileADir = join(testState.dir, 'profiles', 'a')
    const profileBDir = join(testState.dir, 'profiles', 'b')
    const profileADataFile = join(profileADir, 'orca-data.json')
    const profileBDataFile = join(profileBDir, 'orca-data.json')
    mkdirSync(profileADir, { recursive: true })
    mkdirSync(profileBDir, { recursive: true })

    vi.resetModules()
    const { Store } = await import('./loading-store/store')
    const { initDataPath } = await import('./loading-store/user-data-path')
    initDataPath()
    const profileAStore = createSqliteTestStore(Store, { dataFile: profileADataFile })
    profileAStore.setGitHubCache({ pr: { 'o/r#a': dataLessPrCacheEntry(10) }, issue: {} })
    await profileAStore.flushPendingOrThrowAsync()

    const profileBStore = createSqliteTestStore(Store, { dataFile: profileBDataFile })
    expect(profileBStore.getGitHubCache().pr['o/r#a']).toBeUndefined()
    profileBStore.setGitHubCache({ pr: { 'o/r#b': dataLessPrCacheEntry(20) }, issue: {} })
    await profileBStore.flushPendingOrThrowAsync()

    const restartedProfileA = createSqliteTestStore(Store, { dataFile: profileADataFile })
    const restartedProfileB = createSqliteTestStore(Store, { dataFile: profileBDataFile })
    expect(restartedProfileA.getGitHubCache().pr['o/r#a']).toEqual({ fetchedAt: 10 })
    expect(restartedProfileA.getGitHubCache().pr['o/r#b']).toBeUndefined()
    expect(restartedProfileB.getGitHubCache().pr['o/r#b']).toEqual({ fetchedAt: 20 })
  })
})
