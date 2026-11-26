import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../shared/secure-storage/secret-store', () => ({
  getSecretStore: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(`sealed:${plain}`, 'utf8'),
    decryptString: (cipher: Buffer) => cipher.toString('utf8').replace(/^sealed:/, '')
  })
}))

describe('Command Code API key store', () => {
  let home = ''
  beforeEach(() => {
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; both point at a throwaway directory.
    home = mkdtempSync(join(tmpdir(), 'command-code-key-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  it('round-trips a trimmed key without writing the plaintext to disk', async () => {
    const store = await import('./command-code-api-key-store')
    expect(await store.hasCommandCodeApiKey()).toBe(false)

    await store.saveCommandCodeApiKey('  cc-secret-value  ')
    expect(await store.hasCommandCodeApiKey()).toBe(true)
    expect(await store.readCommandCodeApiKey()).toBe('cc-secret-value')

    const onDisk = readFileSync(store.commandCodeApiKeyEnvelopeFile().path, 'utf8')
    expect(onDisk).not.toContain('cc-secret-value')
    expect(onDisk.startsWith(store.commandCodeApiKeyEnvelopeFile().envelopePrefix)).toBe(true)

    await store.clearCommandCodeApiKey()
    expect(await store.hasCommandCodeApiKey()).toBe(false)
  })
})
