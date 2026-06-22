import { describe, expect, it, vi } from 'vitest'

vi.mock('./chromium-profile-discovery', () => ({
  CHROMIUM_BROWSERS: [
    {
      family: 'chrome',
      label: 'Google Chrome',
      keychainService: 'Chrome Safe Storage',
      keychainAccount: 'Chrome'
    }
  ],
  browserRootPath: () => '/root',
  discoverProfiles: () => [{ name: 'Default', directory: 'Default' }],
  isSafeBrowserProfileDirectory: (d: string) => !d.includes('..') && !d.includes('/'),
  detectChromiumBrowsers: () => [
    {
      family: 'chrome',
      label: 'Google Chrome',
      root: '/root',
      keychainService: 'Chrome Safe Storage',
      keychainAccount: 'Chrome',
      profiles: [{ name: 'Default', directory: 'Default' }],
      selectedProfile: 'Default'
    }
  ]
}))
vi.mock('./chromium-encryption-key', () => ({
  getEncryptionKey: () => ({ key: Buffer.alloc(16), mode: 'aes-128-cbc' })
}))
vi.mock('./sqlite-store-copy', () => ({
  copyChromiumStoreToTemp: () => ({
    tempDir: '/tmp/x',
    tempDbPath: '/tmp/x/Login Data',
    cleanup: vi.fn()
  })
}))
vi.mock('./chromium-login-import', () => ({
  readChromiumLogins: () => [{ origin: 'https://github.com', username: 'me', password: 'pw' }]
}))

import { importPasswordsFromBrowser } from './password-import-service'

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

  it('rejects an unsafe profile name', () => {
    const importMany = vi.fn()
    const result = importPasswordsFromBrowser(
      { importMany },
      { browserFamily: 'chrome', browserProfile: '../evil' }
    )
    expect(result).toMatchObject({ ok: false })
    expect(importMany).not.toHaveBeenCalled()
  })
})
