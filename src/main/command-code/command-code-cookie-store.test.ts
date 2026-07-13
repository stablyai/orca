import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((value: string) => Buffer.from(value)),
  decryptString: vi.fn((value: Buffer) => value.toString('utf8'))
}))

const electronMock = vi.hoisted(() => ({
  safeStorage: safeStorageMock
}))

vi.mock('electron', () => electronMock)

const existsSyncMock = vi.hoisted(() => vi.fn())
const readFileSyncMock = vi.hoisted(() => vi.fn())
const rmSyncMock = vi.hoisted(() => vi.fn())
const hardenMock = vi.hoisted(() => vi.fn())
const writeSecureMock = vi.hoisted(() => vi.fn())
const homedirMock = vi.hoisted(() => vi.fn(() => '/home/test'))

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  rmSync: rmSyncMock
}))

vi.mock('node:os', () => ({
  homedir: homedirMock
}))

vi.mock('node:path', () => ({
  join: (...parts: string[]) => parts.join('/')
}))

vi.mock('../../shared/secure-file', () => ({
  hardenExistingSecureFile: hardenMock,
  writeSecureFile: writeSecureMock
}))

import {
  clearCommandCodeSessionCookie,
  hasCommandCodeSessionCookie,
  readCommandCodeSessionCookie,
  saveCommandCodeSessionCookie
} from './command-code-cookie-store'

const TEST_COOKIE = 'token=abc; data=xyz'

describe('command-code-cookie-store', () => {
  beforeEach(() => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.encryptString.mockImplementation((value: string) => Buffer.from(value))
    safeStorageMock.decryptString.mockImplementation((value: Buffer) => value.toString('utf8'))
    existsSyncMock.mockReturnValue(false)
    clearCommandCodeSessionCookie()
  })

  it('reports not configured with no cookie saved', () => {
    expect(hasCommandCodeSessionCookie()).toBe(false)
  })

  it('returns null reading with no cookie saved', () => {
    expect(readCommandCodeSessionCookie()).toBeNull()
  })

  it('rejects empty cookie string', () => {
    expect(() => saveCommandCodeSessionCookie('')).toThrow('required')
  })

  it('rejects whitespace-only cookie string', () => {
    expect(() => saveCommandCodeSessionCookie('   ')).toThrow('required')
  })

  it('saves and reads back from cache', () => {
    saveCommandCodeSessionCookie(TEST_COOKIE)
    expect(readCommandCodeSessionCookie()).toBe(TEST_COOKIE)
  })

  it('caches for repeated reads', () => {
    saveCommandCodeSessionCookie(TEST_COOKIE)
    expect(readCommandCodeSessionCookie()).toBe(TEST_COOKIE)
    expect(readCommandCodeSessionCookie()).toBe(TEST_COOKIE)
  })

  it('clears the cache', () => {
    saveCommandCodeSessionCookie(TEST_COOKIE)
    clearCommandCodeSessionCookie()
    expect(readCommandCodeSessionCookie()).toBeNull()
  })
})
