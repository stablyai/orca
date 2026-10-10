import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore, type SecretStore } from '../shared/secret-store'
import { sealCredentialForStorage } from './integration-credential-file'

function installStore(asyncAvailable: boolean) {
  const syncFormUsed = (): never => {
    throw new Error('sync safeStorage form used')
  }
  const store = {
    isEncryptionAvailable: vi.fn(syncFormUsed),
    encryptString: vi.fn(syncFormUsed),
    decryptString: vi.fn(syncFormUsed),
    isEncryptionAvailableAsync: vi.fn(async () => asyncAvailable),
    encryptStringAsync: vi.fn(async (plainText: string) => Buffer.from(`sealed:${plainText}`)),
    decryptStringAsync: vi.fn(async () => ({ plainText: '', shouldReEncrypt: false })),
    describeProtectionGap: () => null
  } satisfies SecretStore
  setSecretStore(store)
  return store
}

describe('sealCredentialForStorage', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('seals through the async safeStorage API only', async () => {
    const store = installStore(true)
    await expect(sealCredentialForStorage('Linear', 'lin_api_token')).resolves.toEqual(
      Buffer.from('sealed:lin_api_token')
    )
    expect(store.encryptStringAsync).toHaveBeenCalledWith('lin_api_token')
  })

  it('stores plaintext, with a warning, when the async API cannot seal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = installStore(false)
    await expect(sealCredentialForStorage('Jira', 'jira-token')).resolves.toEqual(
      Buffer.from('jira-token', 'utf-8')
    )
    expect(store.encryptStringAsync).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[jira] secret encryption unavailable — storing credential in plaintext'
    )
  })
})
