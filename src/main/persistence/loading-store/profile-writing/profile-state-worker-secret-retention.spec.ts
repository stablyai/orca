import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSecretStore, setSecretStore } from '../../../../shared/secure-storage/secret-store'
import {
  deferred,
  fixture,
  withReopenedProfileStore
} from './profile-state-delayed-authority-fixture'

export function registerProfileStateWorkerSecretRetentionTests(): void {
  let encryptionAvailable = true
  let previousSecretStore: ReturnType<typeof getSecretStore>
  const ciphertext = (plaintext: string) => Buffer.from(`sealed:${plaintext}`).toString('base64')

  beforeEach(() => {
    encryptionAvailable = true
    previousSecretStore = getSecretStore()
    setSecretStore({
      isEncryptionAvailable: () => encryptionAvailable,
      encryptString: (value) => Buffer.from(`sealed:${value}`),
      decryptString: (value) => value.toString().slice('sealed:'.length),
      describeProtectionGap: () => null
    })
  })
  afterEach(() => setSecretStore(previousSecretStore))

  describe.each(['opencodeSessionCookie'] as const)(
    'Store %s retention across worker acknowledgements',
    (setting) => {
      it('does not restore ciphertext cleared while its commit acknowledgement was pending', async () => {
        const { store, authority, readState } = await fixture()
        store.updateSettings({ [setting]: 'durable' })
        await store.flushPendingOrThrowAsync()
        const gate = authority.pause()
        store.updateSettings({ [setting]: 'in-flight' })
        const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
        await gate.started.promise
        store.updateSettings({ [setting]: '' })
        encryptionAvailable = false
        gate.finish.resolve()
        await write
        await store.flushPendingOrThrowAsync()
        expect(readState().settings[setting]).toBe('')
        expect(store.getSettings()[setting]).toBe('')
      })
    }
  )

  it('does not restore the migrated legacy Go ciphertext from a pending worker acknowledgement', async () => {
    const { store, authority, readState } = await fixture(ciphertext('legacy-go-key'))
    const gate = authority.pause()
    store.updateSettings({ theme: 'dark' })
    const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    const save = vi.fn()
    await store.migrateLegacyOpenCodeGoApiKey({ has: () => false, read: () => null, save })
    encryptionAvailable = false
    gate.finish.resolve()
    await write
    await store.flushPendingOrThrowAsync()
    expect(save).toHaveBeenCalledExactlyOnceWith('legacy-go-key')
    expect(readState().settings).not.toHaveProperty('opencodeGoApiKey')
    expect(store.getSettings()).not.toHaveProperty('opencodeGoApiKey')
    encryptionAvailable = true
    store.updateSettings({ theme: 'light' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings).not.toHaveProperty('opencodeGoApiKey')
  })

  it('saves the proxy changed while its seal was in flight, with no synchronous sealing', async () => {
    const { store, readState } = await fixture()
    const seals: { plaintext: string; sealed: ReturnType<typeof deferred<Buffer>> }[] = []
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('synchronous sealing is unavailable on this host')
      },
      encryptStringAsync: (value) => {
        const sealed = deferred<Buffer>()
        seals.push({ plaintext: value, sealed })
        return sealed.promise
      },
      decryptString: (value) => value.toString().slice('sealed:'.length),
      describeProtectionGap: () => null
    })
    store.updateSettings({ httpProxyUrl: 'http://first.example:8080' })
    const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await vi.waitFor(() => expect(seals).toHaveLength(1))
    store.updateSettings({ httpProxyUrl: 'http://second.example:8080' })
    seals[0].sealed.resolve(Buffer.from('sealed:http://first.example:8080'))
    await vi.waitFor(() => expect(seals).toHaveLength(2))
    expect(seals[1].plaintext).toBe('http://second.example:8080')
    seals[1].sealed.resolve(Buffer.from('sealed:http://second.example:8080'))
    await write
    await withReopenedProfileStore(readState(), 'reopened-orca-data.json', (reopened) => {
      expect(reopened.getSettings().httpProxyUrl).toBe('http://second.example:8080')
    })
  })
}
