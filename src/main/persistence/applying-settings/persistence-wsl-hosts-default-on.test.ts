import {
  closeTestStores,
  createStore,
  readPersistedState,
  testState,
  writeDataFile
} from '../persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(plaintext, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8')
  }
}))

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))

// Every pre-rollout profile persisted the old default, so a saved false carries no choice.
function writeProfileSettings(settings: Record<string, unknown>): void {
  const defaults = getDefaultPersistedState(testState.dir)
  const {
    experimentalWslHostsDefaultedOn: _guard,
    experimentalWslHosts: _setting,
    ...rest
  } = defaults.settings
  writeDataFile({ ...defaults, settings: { ...rest, ...settings } })
}

describe('WSL hosts default-on rollout', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-wsl-hosts-default-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('is on for a fresh profile', async () => {
    const store = await createStore()
    expect(store.getSettings().experimentalWslHosts).toBe(true)
  })

  it('turns on a pre-rollout saved false once and persists the guard', async () => {
    writeProfileSettings({ experimentalWslHosts: false })
    const store = await createStore()
    expect(store.getSettings().experimentalWslHosts).toBe(true)
    await store.flushPendingOrThrowAsync()
    expect(readPersistedState().settings).toMatchObject({
      experimentalWslHosts: true,
      experimentalWslHostsDefaultedOn: true
    })
  })

  it('keeps an opt-out made after the rollout across restarts', async () => {
    writeProfileSettings({ experimentalWslHosts: false })
    const first = await createStore()
    first.updateSettings({ experimentalWslHosts: false })
    await first.flushPendingOrThrowAsync()
    await closeTestStores()

    const second = await createStore()
    expect(second.getSettings().experimentalWslHosts).toBe(false)
  })

  it('keeps a saved false once the guard is stamped', async () => {
    writeProfileSettings({ experimentalWslHosts: false, experimentalWslHostsDefaultedOn: true })
    const store = await createStore()
    expect(store.getSettings().experimentalWslHosts).toBe(false)
  })

  it('stamps the guard on any explicit write, so an older default can never be re-read as unset', async () => {
    writeProfileSettings({ experimentalWslHosts: true })
    const store = await createStore()
    store.updateSettings({ experimentalWslHostsDefaultedOn: false, experimentalWslHosts: false })
    expect(store.getSettings()).toMatchObject({
      experimentalWslHosts: false,
      experimentalWslHostsDefaultedOn: true
    })
  })
})
