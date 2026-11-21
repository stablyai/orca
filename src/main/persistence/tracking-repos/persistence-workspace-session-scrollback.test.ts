import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createSqliteTestStore,
  makeRepo,
  testState
} from '../persistence-test-harness'
import { TEST_LEAF_2, makeSessionWithTerminalBuffers } from '../persistence-session-fixtures'

import { installFakeAppEnvironment } from '../../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import { Store } from '../loading-store/store'
import { initDataPath } from '../loading-store/user-data-path'

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

  it('stores scrollback with its profile and reads older snapshots from the legacy directory', async () => {
    const profileDataDirectory = join(testState.dir, 'profiles', 'local-default')
    const profileDataFile = join(profileDataDirectory, 'orca-data.json')
    mkdirSync(profileDataDirectory, { recursive: true })

    // Legacy snapshot paths resolve through AppEnvironment; use this fixture’s userData.
    installFakeAppEnvironment({ getPath: () => testState.dir })
    initDataPath()
    const store = createSqliteTestStore(Store, { dataFile: profileDataFile })
    store.addRepo(makeRepo({ id: 'remote-repo', connectionId: 'ssh-target-1' }))
    const session = makeSessionWithTerminalBuffers()
    store.setWorkspaceSession({
      ...session,
      tabsByWorktree: { 'remote-repo::/remote': session.tabsByWorktree['remote-repo::/remote'] },
      terminalLayoutsByTabId: { 'remote-tab': session.terminalLayoutsByTabId['remote-tab'] }
    })

    const ref =
      store.getWorkspaceSession().terminalLayoutsByTabId['remote-tab'].scrollbackRefsByLeafId?.[
        TEST_LEAF_2
      ]
    if (!ref) {
      throw new Error('Expected a scrollback snapshot reference')
    }
    expect(existsSync(join(profileDataDirectory, 'terminal-scrollback', `${ref}.bin`))).toBe(true)
    expect(existsSync(join(testState.dir, 'terminal-scrollback', `${ref}.bin`))).toBe(false)
    expect(await store.readTerminalScrollbackSnapshotAsync(ref)).toBe('remote-scrollback')

    const legacyRef = 'v1-11111111111111111111111111111111'
    const legacySnapshotDir = join(testState.dir, 'terminal-scrollback')
    mkdirSync(legacySnapshotDir, { recursive: true })
    writeFileSync(join(legacySnapshotDir, `${legacyRef}.bin`), 'legacy-scrollback', 'utf-8')

    expect(await store.readTerminalScrollbackSnapshotAsync(legacyRef)).toBe('legacy-scrollback')
  })
})
