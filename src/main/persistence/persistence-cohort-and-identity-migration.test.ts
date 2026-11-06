import {
  closeTestStores,
  testState,
  createStore,
  dataFile,
  writeDataFile,
  makeRepo
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { createProfileStateStore } from './profile-state/profile-state-store-factory'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

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
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })
  // Cohort on file existence so pre-telemetry profiles cannot default to opted in.

  it('retains the existing-user cohort when a corrupt legacy primary recovers from backup', async () => {
    await withRecoveredLegacyProfile((store) => {
      const telemetry = store.getSettings().telemetry
      expect(telemetry?.existedBeforeTelemetryRelease).toBe(true)
      expect(telemetry?.optedIn).toBeNull()
      expect(telemetry?.installId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      )
      expect(store.getSettings().experimentalNewWorktreeCardStyle).toBe(false)
    })
  })
})

describe('Store.migrateWorktreeIdentity', () => {
  const OLD = 'repo1::/ws/cunner'
  const NEW = 'repo1::/ws/worktree-creation-spinner'

  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('moves persisted mobile selections across reloads', async () => {
    const store = await createStore()
    // Register the repo so orphan cleanup does not discard the fixture on reload.
    store.addRepo(makeRepo({ id: 'repo1', path: '/repo1' }))
    store.setMobileClientTabSelections({
      'device-a': {
        [OLD]: { activeTabId: 'tab-1', activeGroupId: null, activeTabIdByGroupId: {} }
      }
    })

    store.migrateWorktreeIdentity(hostWorktreeTarget({ id: OLD, hostId: 'local' }), NEW)
    store.flush()

    expect(store.getMobileClientTabSelections()['device-a']?.[OLD]).toBeUndefined()
    const reloaded = await createStore()
    expect(reloaded.getMobileClientTabSelections()['device-a']?.[NEW]?.activeTabId).toBe('tab-1')
  })

  it('keeps the newest visit timestamp when a partial migration left both identities', async () => {
    const store = await createStore()
    store.setWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      lastVisitedAtByWorktreeId: { [OLD]: 100, [NEW]: 900 }
    })

    store.migrateWorktreeIdentity(hostWorktreeTarget({ id: OLD, hostId: 'local' }), NEW)

    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.[OLD]).toBeUndefined()
    expect(store.getWorkspaceSession().lastVisitedAtByWorktreeId?.[NEW]).toBe(900)
  })
})

async function withRecoveredLegacyProfile(
  verify: (store: ReturnType<typeof createProfileStateStore>['store']) => void
): Promise<void> {
  writeDataFile({ schemaVersion: 1, repos: [], worktreeMeta: {}, settings: {}, ui: {} })
  writeFileSync(`${dataFile()}.bak.0`, readFileSync(dataFile()))
  writeFileSync(dataFile(), '{{{corrupt json')
  const { store } = createProfileStateStore({
    dataFile: dataFile(),
    databaseFile: join(testState.dir, 'profile-state.db'),
    profileId: 'cohort-recovery'
  })
  try {
    verify(store)
  } finally {
    await store.freezeWritesAsync()
  }
}
