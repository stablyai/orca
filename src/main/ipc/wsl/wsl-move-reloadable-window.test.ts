import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeTestStores, createSqliteTestStore } from '../../persistence/persistence-test-harness'
import { leaveSettingsForWslMoveReload } from './wsl-move-reloadable-window'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').replace('encrypted:', '')
  }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('../../ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

async function openStore() {
  const { Store } = await import('../../persistence/loading-store/store')
  return createSqliteTestStore(Store, { dataFile: join(testState.dir, 'orca-data.json') })
}

describe('WSL move window reload landing', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-wsl-move-reload-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('lands a reload started from Settings on the workspace view, and so does the next launch', async () => {
    const store = await openStore()
    store.updateUI({ activeView: 'settings' })

    leaveSettingsForWslMoveReload(store)

    expect(store.getUI().activeView).toBe('terminal')
    store.flush()
    const relaunched = await openStore()
    expect(relaunched.getUI().activeView).toBe('terminal')
  })
})
