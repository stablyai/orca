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

describe('Store secret retention across worker acknowledgements', () => {
  it('does not restore ciphertext cleared while its commit acknowledgement was pending', async () => {
    const { store, authority, readState } = await fixture()
    store.updateSettings({ opencodeSessionCookie: 'durable' })
    await store.flushPendingOrThrowAsync()
    const gate = authority.pause()
    store.updateSettings({ opencodeSessionCookie: 'in-flight' })
    const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    store.updateSettings({ opencodeSessionCookie: '' })
    encryptionAvailable = false
    gate.finish.resolve()
    await write
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe('')
    expect(store.getSettings().opencodeSessionCookie).toBe('')
  })

  it('retains confirmed ciphertext until a newer secret can be encrypted', async () => {
    const { store, authority, readState } = await fixture()
    store.updateSettings({ opencodeSessionCookie: 'durable' })
    await store.flushPendingOrThrowAsync()
    const gate = authority.pause()
    store.updateSettings({ opencodeSessionCookie: 'in-flight' })
    const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    await gate.started.promise
    store.updateSettings({ opencodeSessionCookie: 'newer' })
    encryptionAvailable = false
    gate.finish.resolve()
    await write
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe(ciphertext('in-flight'))
    expect(store.getSettings().opencodeSessionCookie).toBe('newer')
    encryptionAvailable = true
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe(ciphertext('newer'))
  })

  it('retains the earlier ciphertext after a failed write and retries newer plaintext', async () => {
    const { store, authority, readState } = await fixture()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    store.updateSettings({ opencodeSessionCookie: 'durable' })
    await store.flushPendingOrThrowAsync()
    const gate = authority.pause()
    store.updateSettings({ opencodeSessionCookie: 'failed' })
    const write = store.flushPendingOrThrowAsync({ drainToStableGeneration: false })
    const failure = expect(write).rejects.toThrow('disk refused')
    await gate.started.promise
    store.updateSettings({ opencodeSessionCookie: 'newer' })
    encryptionAvailable = false
    gate.finish.reject(new Error('disk refused'))
    await failure
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe(ciphertext('durable'))
    encryptionAvailable = true
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    expect(readState().settings.opencodeSessionCookie).toBe(ciphertext('newer'))
  })
})
