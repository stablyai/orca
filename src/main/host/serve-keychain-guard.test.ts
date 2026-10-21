import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(),
    decryptString: vi.fn()
  }
}))

const { withholdUnreachableKeychainForServe } = await import('./serve-keychain-guard')
const { resetSafeStorageWithholdForTests, safeStorageWithheldReason } =
  await import('./safe-storage-availability')

describe('withholdUnreachableKeychainForServe', () => {
  afterEach(() => resetSafeStorageWithholdForTests())

  it('withholds the keychain and says why when macOS has none to offer', async () => {
    const warn = vi.fn()
    await withholdUnreachableKeychainForServe({
      platform: 'darwin',
      probe: async () => ({ kind: 'unavailable', reason: 'no_default_keychain' }),
      warn
    })
    expect(safeStorageWithheldReason()).toBe('this login has no default macOS keychain')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Secrets are unavailable for this run')
    )
  })

  it('leaves a reachable or undecided keychain alone, and never probes off macOS', async () => {
    const probe = vi.fn(async () => ({ kind: 'reachable' as const }))
    await withholdUnreachableKeychainForServe({ platform: 'darwin', probe })
    await withholdUnreachableKeychainForServe({
      platform: 'darwin',
      probe: async () => ({ kind: 'unknown' })
    })
    expect(safeStorageWithheldReason()).toBeNull()

    const skippedProbe = vi.fn()
    await withholdUnreachableKeychainForServe({ platform: 'linux', probe: skippedProbe })
    await withholdUnreachableKeychainForServe({
      platform: 'darwin',
      usesMockKeychain: true,
      probe: skippedProbe
    })
    expect(skippedProbe).not.toHaveBeenCalled()
  })
})
