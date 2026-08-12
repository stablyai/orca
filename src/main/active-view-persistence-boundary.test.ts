import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getActiveViewPreferenceFile } from './active-view-preference'

const testState = { dir: '' }

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').replace('encrypted:', '')
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))
vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))

describe('active-view persistence boundary', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-active-view-boundary-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('persists a view switch without changing the global durable snapshot', async () => {
    vi.useFakeTimers()
    vi.resetModules()
    const { Store } = await import('./persistence')
    const dataFile = join(testState.dir, 'orca-data.json')
    const store = new Store({ dataFile })
    store.flush()
    const durableBefore = readFileSync(dataFile, 'utf-8')

    store.updateUI({ activeView: 'settings' })
    vi.advanceTimersByTime(1_000)
    await store.waitForPendingWrite()

    const preferenceFile = getActiveViewPreferenceFile(dataFile)
    const preferencePayload = readFileSync(preferenceFile, 'utf-8')
    expect(Buffer.byteLength(preferencePayload)).toBeLessThan(64)
    expect(JSON.parse(preferencePayload)).toEqual({ activeView: 'settings' })
    expect(readFileSync(dataFile, 'utf-8')).toBe(durableBefore)
    expect(store.getUI().activeView).toBe('settings')

    const reloaded = new Store({ dataFile })
    expect(reloaded.getUI().activeView).toBe('settings')
  })
})
