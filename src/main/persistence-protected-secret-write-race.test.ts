import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSecretStore, setSecretStore } from '../shared/secret-store'
import {
  createWorkerMaintenanceFixture,
  maintenanceBarrier
} from './persistence/loading-store/profile-state-maintenance-fixture'
import { Store } from './persistence/loading-store/store'

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

let encryptionAvailable = true
let previousSecretStore: ReturnType<typeof getSecretStore>

beforeEach(() => {
  encryptionAvailable = true
  previousSecretStore = getSecretStore()
  setSecretStore({
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
    decryptString: (ciphertext) => ciphertext.toString('utf8').slice('enc:'.length),
    describeProtectionGap: () => null
  })
})
afterEach(() => setSecretStore(previousSecretStore))

describe('protected-secret async write retention', () => {
  it('does not retain ciphertext from a rejected worker write after a newer secret arrives', async () => {
    const { store, authority, peer, dataFile, readState } = await createWorkerMaintenanceFixture()
    store.updateSettings({ opencodeSessionCookie: 'durable-cookie' })
    await store.flushPendingOrThrowAsync()
    const durableCiphertext = readState().settings.opencodeSessionCookie
    const entered = maintenanceBarrier()
    const release = maintenanceBarrier()
    const writeDomains = authority.writeSerializedDomains.bind(authority)
    const pendingWrite = vi
      .spyOn(authority, 'writeSerializedDomains')
      .mockImplementationOnce(async () => {
        entered.resolve()
        await release.promise
        await writeDomains([{ domain: 'settings', payload: '{' }])
      })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    store.updateSettings({ opencodeSessionCookie: 'intermediate-cookie' })
    const writing = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const rejected = expect(writing).rejects.toMatchObject({ outcome: 'known-failure' })
    await entered.promise
    store.updateSettings({ opencodeSessionCookie: 'replacement-cookie' })
    encryptionAvailable = false
    release.resolve()
    await rejected
    pendingWrite.mockRestore()
    await store.flushPendingOrThrowAsync()

    expect(readState().settings.opencodeSessionCookie).toBe(durableCiphertext)
    expect(store.getSettings().opencodeSessionCookie).toBe('replacement-cookie')
    encryptionAvailable = true
    const restarted = new Store({ dataFile, profileStateAuthority: peer() })
    try {
      expect(restarted.getSettings().opencodeSessionCookie).toBe('durable-cookie')
    } finally {
      restarted.freezeWrites()
    }

    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe(
      Buffer.from('enc:replacement-cookie').toString('base64')
    )
  })
})
