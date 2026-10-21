import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

const secretStore = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  decryptString: vi.fn((value: Buffer) => value.toString().slice(4))
}))

vi.mock('../../../shared/secret-store', () => ({ getSecretStore: () => secretStore }))

const { ProtectedSecretPersistence } = await import('../../protected-secret-persistence')
const {
  LEGACY_OPENCODE_GO_API_KEY_SLOT,
  migrateLegacyOpenCodeGoApiKey,
  retainLegacyOpenCodeGoApiKey
} = await import('./legacy-opencode-go-api-key-migration')

const SEALED = Buffer.from('enc:fake-legacy-key').toString('base64')

function memoryStore(initial: string | null = null): {
  has: () => boolean
  read: () => string | null
  save: Mock<(key: string) => void>
  value: () => string | null
} {
  let saved = initial
  return {
    has: () => saved !== null,
    read: () => saved,
    save: vi.fn((key: string) => {
      saved = key
    }),
    value: () => saved
  }
}

function parked(value: unknown = SEALED): InstanceType<typeof ProtectedSecretPersistence> {
  const secrets = new ProtectedSecretPersistence()
  retainLegacyOpenCodeGoApiKey({ opencodeGoApiKey: value }, secrets)
  return secrets
}

beforeEach(() => {
  vi.clearAllMocks()
  secretStore.isEncryptionAvailable.mockReturnValue(true)
  secretStore.decryptString.mockImplementation((value: Buffer) => value.toString().slice(4))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('retainLegacyOpenCodeGoApiKey', () => {
  it('drops the field from settings and parks the ciphertext without decrypting it', () => {
    const settings: Record<string, unknown> = { opencodeGoApiKey: SEALED, other: 1 }
    const secrets = new ProtectedSecretPersistence()

    retainLegacyOpenCodeGoApiKey(settings, secrets)

    expect(settings).toEqual({ other: 1 })
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBe(SEALED)
    expect(secretStore.decryptString).not.toHaveBeenCalled()
  })

  it('seals a #22551 plaintext key before parking it, and migration still recovers it', () => {
    const secrets = parked('sk-fake-plaintext-key')

    const blob = secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)
    expect(blob).toBe(Buffer.from('enc:sk-fake-plaintext-key').toString('base64'))
    const store = memoryStore()
    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(true)
    expect(store.value()).toBe('sk-fake-plaintext-key')
  })

  it('parks a plaintext key verbatim while encryption is unavailable', () => {
    secretStore.isEncryptionAvailable.mockReturnValue(false)
    const secrets = parked('sk-fake-plaintext-key')

    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBe('sk-fake-plaintext-key')
    expect(secretStore.encryptString).not.toHaveBeenCalled()
  })

  it('ignores settings without the field and drops malformed values', () => {
    const secrets = new ProtectedSecretPersistence()
    retainLegacyOpenCodeGoApiKey({ other: 1 }, secrets)
    retainLegacyOpenCodeGoApiKey(undefined, secrets)
    const malformed: Record<string, unknown> = { opencodeGoApiKey: { nested: 'fake' } }
    retainLegacyOpenCodeGoApiKey(malformed, secrets)

    expect(malformed).toEqual({})
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBeNull()
  })
})

describe('migrateLegacyOpenCodeGoApiKey', () => {
  it('saves the key into an empty store, then releases the legacy value', () => {
    const secrets = parked()
    const store = memoryStore()

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(true)
    expect(store.value()).toBe('fake-legacy-key')
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBeNull()
  })

  it('is idempotent: a second run has nothing left to move', () => {
    const secrets = parked()
    const store = memoryStore()

    migrateLegacyOpenCodeGoApiKey(secrets, store)
    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(false)
    expect(store.save).toHaveBeenCalledOnce()
  })

  it('never overwrites a readable key already saved in the store, and releases the legacy value', () => {
    const secrets = parked()
    const store = memoryStore('fake-current-key')

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(true)
    expect(store.save).not.toHaveBeenCalled()
    expect(store.value()).toBe('fake-current-key')
    expect(secretStore.decryptString).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      '[opencode-go] Kept the existing saved API key and dropped the one from settings.'
    )
  })

  it('keeps the legacy value when the existing store file cannot be read by this build', () => {
    const secrets = parked()
    const store = {
      ...memoryStore('fake-other-build-key'),
      read: () => {
        throw new Error('OpenCode Go API key could not be decrypted')
      }
    }

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(false)
    expect(store.save).not.toHaveBeenCalled()
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBe(SEALED)
  })

  it('keeps the ciphertext while safeStorage is unavailable so a later startup retries', () => {
    const secrets = parked()
    const store = memoryStore()
    secretStore.isEncryptionAvailable.mockReturnValue(false)

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(false)
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBe(SEALED)

    secretStore.isEncryptionAvailable.mockReturnValue(true)
    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(true)
    expect(store.value()).toBe('fake-legacy-key')
  })

  it('keeps the ciphertext after a definitive decrypt failure', () => {
    const secrets = parked()
    const store = memoryStore()
    secretStore.decryptString.mockImplementation(() => {
      throw new Error('bad key')
    })

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(false)
    expect(store.save).not.toHaveBeenCalled()
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBe(SEALED)
  })

  it('moves a plaintext key #22551 accepted when it failed to decrypt', () => {
    secretStore.isEncryptionAvailable.mockReturnValue(false)
    const secrets = parked('sk-fake-plaintext-key')
    secretStore.isEncryptionAvailable.mockReturnValue(true)
    const store = memoryStore()
    secretStore.decryptString.mockImplementation(() => {
      throw new Error('not ciphertext')
    })

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(true)
    expect(store.value()).toBe('sk-fake-plaintext-key')
  })

  it('keeps the ciphertext when the store cannot save, without logging the key', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secrets = parked()
    const store = {
      has: () => false,
      read: () => null,
      save: () => {
        throw new Error('disk full')
      }
    }

    expect(migrateLegacyOpenCodeGoApiKey(secrets, store)).toBe(false)
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBe(SEALED)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fake-legacy-key')

    const working = memoryStore()
    expect(migrateLegacyOpenCodeGoApiKey(secrets, working)).toBe(true)
    expect(working.value()).toBe('fake-legacy-key')
    expect(secrets.sealedBlob(LEGACY_OPENCODE_GO_API_KEY_SLOT)).toBeNull()
  })
})
