import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./chromium-profile-discovery', () => ({
  CHROMIUM_BROWSERS: [
    {
      family: 'chrome',
      label: 'Google Chrome',
      keychainService: 'Chrome Safe Storage',
      keychainAccount: 'Chrome'
    }
  ],
  browserRootPath: vi.fn(() => '/root'),
  discoverProfiles: vi.fn(() => [{ name: 'Default', directory: 'Default' }]),
  // Why: mirror the full real predicate from chromium-profile-discovery.ts so the
  // security-gate test is honest — rejects '', '.', '\0', '/', '\\', and '..'.
  isSafeBrowserProfileDirectory: vi.fn(
    (d: string) =>
      d.length > 0 &&
      d !== '.' &&
      !d.includes('\0') &&
      !d.includes('/') &&
      !d.includes('\\') &&
      !d.includes('..')
  ),
  detectChromiumBrowsers: vi.fn(() => [
    {
      family: 'chrome',
      label: 'Google Chrome',
      root: '/root',
      keychainService: 'Chrome Safe Storage',
      keychainAccount: 'Chrome',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default'
    }
  ])
}))
vi.mock('./chromium-encryption-key', () => ({
  getEncryptionKey: vi.fn(() => ({ key: Buffer.alloc(16), mode: 'aes-128-cbc' }))
}))
vi.mock('./sqlite-store-copy', () => ({
  copyChromiumStoreToTemp: vi.fn(() => ({
    tempDir: '/tmp/x',
    tempDbPath: '/tmp/x/Login Data',
    cleanup: vi.fn()
  }))
}))
vi.mock('./chromium-login-import', () => ({
  readChromiumLogins: vi.fn(() => [
    { origin: 'https://github.com', username: 'me', password: 'pw' }
  ])
}))

import { getEncryptionKey } from './chromium-encryption-key'
import { readChromiumLogins } from './chromium-login-import'
import { copyChromiumStoreToTemp } from './sqlite-store-copy'
import { importPasswordsFromBrowser } from './password-import-service'

beforeEach(() => {
  vi.clearAllMocks()
  // Restore default implementations after each test so per-case overrides don't leak.
  vi.mocked(getEncryptionKey).mockImplementation(
    () => ({ key: Buffer.alloc(16), mode: 'aes-128-cbc' }) as ReturnType<typeof getEncryptionKey>
  )
  vi.mocked(copyChromiumStoreToTemp).mockImplementation(() => ({
    tempDir: '/tmp/x',
    tempDbPath: '/tmp/x/Login Data',
    cleanup: vi.fn()
  }))
  vi.mocked(readChromiumLogins).mockImplementation(() => [
    { origin: 'https://github.com', username: 'me', password: 'pw' }
  ])
})

describe('importPasswordsFromBrowser', () => {
  it('imports decrypted logins into the vault and returns a summary', () => {
    const importMany = vi.fn().mockReturnValue({ added: 1, skipped: 0, invalid: 0 })
    const result = importPasswordsFromBrowser({ importMany }, { browserFamily: 'chrome' })
    expect(importMany).toHaveBeenCalledWith([
      { origin: 'https://github.com', username: 'me', password: 'pw' }
    ])
    expect(result).toMatchObject({
      ok: true,
      added: 1,
      skipped: 0,
      invalid: 0,
      browserLabel: 'Google Chrome'
    })
  })

  it('rejects an unsafe profile name (path traversal)', () => {
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser(
      { importMany },
      { browserFamily: 'chrome', browserProfile: '../evil' }
    )
    expect(result).toMatchObject({ ok: false })
    expect(importMany).not.toHaveBeenCalled()
  })

  // Finding A: additional unsafe profile names now caught by the full predicate
  it('rejects browserProfile "." (single-dot)', () => {
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser(
      { importMany },
      { browserFamily: 'chrome', browserProfile: '.' }
    )
    expect(result).toMatchObject({ ok: false })
    expect(importMany).not.toHaveBeenCalled()
  })

  // Finding B-1: unknown browser family
  it('returns ok:false for an unknown browser family without calling vault', () => {
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser({ importMany }, { browserFamily: 'unknown' })
    expect(result).toMatchObject({ ok: false })
    expect(importMany).not.toHaveBeenCalled()
  })

  // Finding B-2: getEncryptionKey returns null (keychain access denied)
  it('returns ok:false when getEncryptionKey returns null without calling vault', () => {
    vi.mocked(getEncryptionKey).mockReturnValueOnce(null)
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser({ importMany }, { browserFamily: 'chrome' })
    expect(result).toMatchObject({ ok: false })
    expect(importMany).not.toHaveBeenCalled()
  })

  // Finding B-3: copyChromiumStoreToTemp throws
  it('returns ok:false when copyChromiumStoreToTemp throws without calling vault', () => {
    vi.mocked(copyChromiumStoreToTemp).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser({ importMany }, { browserFamily: 'chrome' })
    expect(result).toMatchObject({ ok: false })
    expect(importMany).not.toHaveBeenCalled()
  })

  // Finding B-4: readChromiumLogins throws AFTER copy → cleanup still runs
  it('calls cleanup even when readChromiumLogins throws (security property)', () => {
    const cleanup = vi.fn()
    vi.mocked(copyChromiumStoreToTemp).mockReturnValueOnce({
      tempDir: '/tmp/x',
      tempDbPath: '/tmp/x/Login Data',
      cleanup
    })
    vi.mocked(readChromiumLogins).mockImplementationOnce(() => {
      throw new Error('sqlite corrupt')
    })
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser({ importMany }, { browserFamily: 'chrome' })
    expect(result).toMatchObject({ ok: false })
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(importMany).not.toHaveBeenCalled()
  })

  // Minor: undefined browserProfile defaults to selectedProfile and succeeds
  it('uses selectedProfile when browserProfile is omitted', () => {
    const importMany = vi.fn().mockReturnValue({ added: 1, skipped: 0, invalid: 0 })
    const result = importPasswordsFromBrowser({ importMany }, { browserFamily: 'chrome' })
    expect(result).toMatchObject({ ok: true, browserLabel: 'Google Chrome' })
    expect(importMany).toHaveBeenCalled()
  })
})
