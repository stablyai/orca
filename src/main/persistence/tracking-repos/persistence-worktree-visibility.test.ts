import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  makeRepo
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { getDefaultPersistedState } from '../../../shared/constants'

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

  it('migrates implicit legacy visibility to an explicit override before defaulting global hide', async () => {
    const persisted = getDefaultPersistedState(testState.dir)
    delete persisted.settings.worktreeVisibilityDefaults
    persisted.repos = [
      makeRepo({
        id: 'legacy',
        kind: 'git',
        externalWorktreeVisibility: undefined,
        externalWorktreeVisibilityLegacy: undefined
      }),
      makeRepo({ id: 'explicit', externalWorktreeVisibility: 'hide' }),
      makeRepo({
        id: 'inherited',
        externalWorktreeVisibility: undefined,
        externalWorktreeVisibilityLegacy: false
      })
    ]
    writeDataFile(persisted)

    const store = await createStore()

    expect(store.getSettings().worktreeVisibilityDefaults).toEqual({ external: 'hide' })
    expect(store.getRepo('legacy')).toMatchObject({
      externalWorktreeVisibility: 'show',
      externalWorktreeVisibilityLegacy: true
    })
    expect(store.getRepo('explicit')?.externalWorktreeVisibility).toBe('hide')
    expect(store.getRepo('inherited')?.externalWorktreeVisibility).toBeUndefined()

    store.flush()
    const reloaded = await createStore()
    expect(reloaded.getRepo('legacy')).toMatchObject({
      externalWorktreeVisibility: 'show',
      externalWorktreeVisibilityLegacy: true
    })
    expect(reloaded.getRepo('inherited')?.externalWorktreeVisibility).toBeUndefined()
  })
})
