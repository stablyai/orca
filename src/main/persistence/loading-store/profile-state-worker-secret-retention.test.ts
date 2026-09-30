import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSecretStore, setSecretStore } from '../../../shared/secret-store'
import { fixture } from './profile-state-delayed-authority-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

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

describe.each(['opencodeSessionCookie', 'opencodeGoApiKey'] as const)(
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

    it('retains confirmed ciphertext until a newer secret can be encrypted', async () => {
      const { store, authority, readState } = await fixture()
      store.updateSettings({ [setting]: 'durable' })
      await store.flushPendingOrThrowAsync()
      const gate = authority.pause()
      store.updateSettings({ [setting]: 'in-flight' })
      const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      await gate.started.promise
      store.updateSettings({ [setting]: 'newer' })
      encryptionAvailable = false
      gate.finish.resolve()
      await write
      await store.flushPendingOrThrowAsync()
      expect(readState().settings[setting]).toBe(ciphertext('in-flight'))
      expect(store.getSettings()[setting]).toBe('newer')
      encryptionAvailable = true
      store.updateSettings({ theme: 'dark' })
      await store.flushPendingOrThrowAsync()
      expect(readState().settings[setting]).toBe(ciphertext('newer'))
    })

    it('retains the earlier ciphertext after a failed write and retries newer plaintext', async () => {
      const { store, authority, readState } = await fixture()
      vi.spyOn(console, 'error').mockImplementation(() => {})
      store.updateSettings({ [setting]: 'durable' })
      await store.flushPendingOrThrowAsync()
      const gate = authority.pause()
      store.updateSettings({ [setting]: 'failed' })
      const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
      const failure = expect(write).rejects.toThrow('disk refused')
      await gate.started.promise
      store.updateSettings({ [setting]: 'newer' })
      encryptionAvailable = false
      gate.finish.reject(new Error('disk refused'))
      await failure
      await store.flushPendingOrThrowAsync()
      expect(readState().settings[setting]).toBe(ciphertext('durable'))
      encryptionAvailable = true
      store.updateSettings({ theme: 'dark' })
      await store.flushPendingOrThrowAsync()
      expect(readState().settings[setting]).toBe(ciphertext('newer'))
    })
  }
)

describe('worker protected settings serialization', () => {
  it.each(['selective', 'complete'] as const)(
    'encrypts both protected credentials in a %s write to SQLite',
    async (mode) => {
      const { store, authority, readState } = await fixture()
      const selectiveWrite = vi.spyOn(authority, 'writeSerializedDomains')
      const completeWrite = vi.spyOn(authority, 'writeCompleteSerializedDomains')
      const secrets = {
        opencodeSessionCookie: 'cookie-only-plaintext',
        opencodeGoApiKey: 'api-key-only-plaintext'
      }
      store.updateSettings(secrets)
      if (mode === 'complete') {
        store.updateOnboarding({ outcome: 'completed' })
      }
      await store.flushPendingOrThrowAsync()
      expect(selectiveWrite).toHaveBeenCalledTimes(mode === 'selective' ? 1 : 0)
      expect(completeWrite).toHaveBeenCalledTimes(mode === 'complete' ? 1 : 0)
      const persisted = readState()
      expect(persisted.settings).toMatchObject({
        opencodeSessionCookie: ciphertext(secrets.opencodeSessionCookie),
        opencodeGoApiKey: ciphertext(secrets.opencodeGoApiKey)
      })
      for (const plaintext of Object.values(secrets)) {
        expect(JSON.stringify(persisted)).not.toContain(plaintext)
      }
      expect(store.getSettings()).toMatchObject(secrets)
    }
  )
})
