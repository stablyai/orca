/**
 * Tests for Anthropic Console credential storage on the runtime auth service.
 *
 * Why: split out of runtime-auth-service.test.ts to stay under the oxlint max-lines limit.
 */
import { createSettings, createStore, testState } from './runtime-auth-service-test-harness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('ClaudeRuntimeAuthService - Console Credentials Storage', () => {
  let safeStorageMock: {
    encryptString: ReturnType<typeof vi.fn>
    decryptString: ReturnType<typeof vi.fn>
    isEncryptionAvailable: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-console-creds-test-'))
    testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-home-test-'))

    safeStorageMock = {
      encryptString: vi.fn((value: string) => Buffer.from(value)),
      decryptString: vi.fn((value: Buffer) => value.toString('utf8')),
      isEncryptionAvailable: vi.fn(() => true)
    }
  })

  afterEach(() => {
    vi.resetModules()
    rmSync(testState.userDataDir, { recursive: true, force: true })
    rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  })

  async function createServiceWithSafeStorage() {
    vi.resetModules()

    vi.doMock('electron', () => ({
      app: {
        getPath: () => testState.userDataDir
      },
      safeStorage: safeStorageMock
    }))

    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
      return {
        ...actual,
        homedir: () => testState.fakeHomeDir
      }
    })

    const { ClaudeRuntimeAuthService } = await import('./runtime-auth-service')
    const store = createStore(createSettings())
    return new ClaudeRuntimeAuthService(store as never)
  }

  it('getConsoleCredential returns null when safeStorage unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)

    const service = await createServiceWithSafeStorage()
    const result = await service.getConsoleCredential()

    expect(result).toBeNull()
    expect(safeStorageMock.isEncryptionAvailable).toHaveBeenCalled()
  })

  it('setConsoleCredential throws when safeStorage unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)

    const service = await createServiceWithSafeStorage()

    await expect(service.setConsoleCredential('test-api-key')).rejects.toThrow(
      'System credential storage unavailable'
    )
  })

  it('setConsoleCredential throws on empty API key', async () => {
    const service = await createServiceWithSafeStorage()

    await expect(service.setConsoleCredential('')).rejects.toThrow('API key cannot be empty')
  })

  it('encrypt/decrypt round-trip works correctly', async () => {
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))

    const service = await createServiceWithSafeStorage()
    const testKey = 'sk-test-1234567890abcdef'

    await service.setConsoleCredential(testKey)
    const retrieved = await service.getConsoleCredential()

    expect(retrieved).toBe(testKey)
    expect(safeStorageMock.encryptString).toHaveBeenCalledWith(testKey)
    expect(safeStorageMock.decryptString).toHaveBeenCalled()
  })

  it('hex encoding/decoding of encrypted data works correctly', async () => {
    const encryptedData = Buffer.from('encrypted-bytes')
    safeStorageMock.encryptString.mockReturnValue(encryptedData)
    safeStorageMock.decryptString.mockReturnValue('test-api-key')

    const service = await createServiceWithSafeStorage()
    const testKey = 'test-api-key'

    await service.setConsoleCredential(testKey)

    const credentialPath = join(testState.userDataDir, 'claude-runtime-auth', 'console-api-key.enc')
    expect(existsSync(credentialPath)).toBe(true)
    const fileContents = readFileSync(credentialPath, 'utf-8')
    expect(fileContents).toBe(encryptedData.toString('hex'))

    const retrieved = await service.getConsoleCredential()
    expect(retrieved).toBe('test-api-key')
  })

  it('getConsoleCredential returns null when credential file does not exist', async () => {
    const service = await createServiceWithSafeStorage()

    const result = await service.getConsoleCredential()

    expect(result).toBeNull()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('clearConsoleCredential removes the encrypted file', async () => {
    const service = await createServiceWithSafeStorage()
    const testKey = 'test-api-key'

    await service.setConsoleCredential(testKey)
    const credentialPath = join(testState.userDataDir, 'claude-runtime-auth', 'console-api-key.enc')
    expect(existsSync(credentialPath)).toBe(true)

    await service.clearConsoleCredential()

    expect(existsSync(credentialPath)).toBe(false)
  })

  it('clearConsoleCredential does not throw when credential file does not exist', async () => {
    const service = await createServiceWithSafeStorage()

    await expect(service.clearConsoleCredential()).resolves.toBeUndefined()
  })

  it('getConsoleCredential handles decryption errors gracefully', async () => {
    const service = await createServiceWithSafeStorage()

    await service.setConsoleCredential('test-key')

    // Mock decryptString to throw (sync, so use mockImplementation)
    safeStorageMock.decryptString.mockImplementation(() => {
      throw new Error('Decryption failed')
    })

    const result = await service.getConsoleCredential()
    expect(result).toBeNull()
  })

  it('setConsoleCredential writes file with restrictive permissions', async () => {
    // Skip on Windows where permission checks work differently
    if (process.platform === 'win32') {
      expect(true).toBe(true)
      return
    }

    const service = await createServiceWithSafeStorage()

    await service.setConsoleCredential('test-api-key')

    const credentialPath = join(testState.userDataDir, 'claude-runtime-auth', 'console-api-key.enc')
    const stats = statSync(credentialPath)

    // mode 0o600 means owner can read/write, no permissions for group/others
    // On Unix: file mode should be 0o100600 (regular file + 0o600)
    expect(stats.mode & 0o777 & 0o077).toBe(0)
  })
})
