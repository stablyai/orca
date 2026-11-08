import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { removeTreeSync } from '../../shared/windows-transient-lock-removal'
import { buildProfileStateCutoverFixture } from './profile-state-cutover-fixture'
import { Store } from './loading-store/store'
import { closeTestStores, dataFile, testState, writeDataFile } from './persistence-test-harness'

const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn(() => ({ nth_repo_added: 2 }))
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))
vi.mock('../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

describe('profile-state cutover fixture', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-profile-cutover-fixture-'))
  })

  afterEach(async () => {
    await closeTestStores()
    removeTreeSync(testState.dir)
  })

  it('fails closed for an invalid serialized import instead of reading a fallback file', () => {
    writeDataFile(buildProfileStateCutoverFixture(testState.dir))

    expect(() => new Store({ dataFile: dataFile(), serializedState: '{not valid json' })).toThrow(
      'Failed to load imported profile state'
    )
  })
})
