import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import type * as Os from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

let tempHome = ''

type SafeStorageMockOptions = {
  encryptionAvailable?: boolean
  decryptString?: (value: Buffer) => string
}

function tokenPath(): string {
  return join(tempHome, '.orca', 'matrix-token.enc')
}

function writeTokenFile(token: string | Buffer): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(tokenPath(), token)
}

async function loadStoreModule(options: SafeStorageMockOptions = {}) {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: {
      isEncryptionAvailable: () => options.encryptionAvailable ?? false,
      encryptString: (value: string) => Buffer.from(value),
      decryptString: options.decryptString ?? ((value: Buffer) => value.toString('utf-8'))
    }
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./matrix-credential-store')
}

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-matrix-cred-'))
  vi.restoreAllMocks()
})

describe('Matrix credential store', () => {
  it('stores and reads back a token at 0600 when safeStorage is unavailable', async () => {
    const store = await loadStoreModule({ encryptionAvailable: false })
    store.storeMatrixToken('syt_token_abc')
    expect(store.hasMatrixToken()).toBe(true)
    expect(store.readMatrixToken()).toBe('syt_token_abc')
  })

  it('encrypts the token when safeStorage is available', async () => {
    const store = await loadStoreModule({ encryptionAvailable: true })
    store.storeMatrixToken('syt_secret')
    // The mock "encrypts" by returning raw bytes; the point is the read round-trips.
    expect(store.readMatrixToken()).toBe('syt_secret')
  })

  it('reads a token written to disk before the module loaded', async () => {
    writeTokenFile('syt_disk')
    const store = await loadStoreModule({ encryptionAvailable: false })
    expect(store.hasMatrixToken()).toBe(true)
    expect(store.readMatrixToken()).toBe('syt_disk')
  })

  it('returns null when no token is stored', async () => {
    const store = await loadStoreModule({ encryptionAvailable: false })
    expect(store.hasMatrixToken()).toBe(false)
    expect(store.readMatrixToken()).toBeNull()
  })

  it('treats an empty token file as missing', async () => {
    writeTokenFile(Buffer.alloc(0))
    const store = await loadStoreModule({ encryptionAvailable: false })
    expect(store.hasMatrixToken()).toBe(false)
    expect(store.readMatrixToken()).toBeNull()
  })

  it('clears the token from disk and cache', async () => {
    const store = await loadStoreModule({ encryptionAvailable: true })
    store.storeMatrixToken('syt_token')
    expect(existsSync(tokenPath())).toBe(true)
    store.clearMatrixToken()
    expect(existsSync(tokenPath())).toBe(false)
    expect(store.hasMatrixToken()).toBe(false)
    expect(store.readMatrixToken()).toBeNull()
  })

  it('throws CredentialDecryptionError when ciphertext cannot be decrypted', async () => {
    // Binary safeStorage-like blob that the legacy plaintext fallback rejects.
    writeTokenFile(Buffer.from([0x76, 0x31, 0x30, 0xff, 0xfe]))
    const store = await loadStoreModule({
      encryptionAvailable: true,
      decryptString: () => {
        throw new Error('userCanceledErr')
      }
    })
    expect(() => store.readMatrixToken()).toThrow(store.CredentialDecryptionError)
    // The token file must survive a failed decrypt so a later keychain approval
    // can recover it.
    expect(existsSync(tokenPath())).toBe(true)
  })
})
