import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSecretStore, setSecretStore } from '../../../../shared/secret-store'
import { fixture } from './profile-state-delayed-authority-fixture'

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
    store.migrateLegacyOpenCodeGoApiKey({ has: () => false, read: () => null, save })
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
}
