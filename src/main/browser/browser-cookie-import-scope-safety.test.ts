import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const { appGetPathMock, copyFileSyncMock, execFileSyncMock, sessionFromPartitionMock } = vi.hoisted(
  () => ({
    appGetPathMock: vi.fn(),
    copyFileSyncMock: vi.fn(),
    execFileSyncMock: vi.fn(),
    sessionFromPartitionMock: vi.fn()
  })
)

vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      copyFileSyncMock(...args)
      return actual.copyFileSync(...args)
    }
  }
})
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: sessionFromPartitionMock }
}))

import {
  importCookiesFromBrowser,
  importCookiesFromFile,
  validateBrowserCookieImportScopeRequest,
  type DetectedBrowser
} from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

function chromeBrowser(cookiesPath: string): DetectedBrowser {
  return {
    family: 'chrome',
    label: 'Google Chrome',
    cookiesPath,
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}

describe('cookie import scope validation', () => {
  it('keeps fixed providers compatible and requires Custom to use a validated scope', () => {
    expect(validateBrowserCookieImportScopeRequest('chatgpt')).toBeNull()
    expect(validateBrowserCookieImportScopeRequest('aistudio')).toBeNull()
    expect(validateBrowserCookieImportScopeRequest('custom')).toBe(
      'Custom Web AI cookie imports require a validated cookie import scope.'
    )
  })

  it('rejects broad or unrelated custom domains', () => {
    expect(
      validateBrowserCookieImportScopeRequest(undefined, {
        label: 'Custom AI',
        domains: ['co.uk'],
        sourceHostname: 'chat.example.co.uk'
      })
    ).toBe('Invalid cookie import scope.')
    expect(
      validateBrowserCookieImportScopeRequest(undefined, {
        label: 'Custom AI',
        domains: ['unrelated.com'],
        sourceHostname: 'chat.example.com'
      })
    ).toBe('Invalid cookie import scope.')
  })
})

describe('scoped cookie file replacement safety', () => {
  let tmpDir: string
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-scope-file-test-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { get: cookiesGetMock, remove: cookiesRemoveMock, set: cookiesSetMock }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCookieFile(cookies: unknown[]): string {
    const filePath = join(tmpDir, 'cookies.json')
    writeFileSync(filePath, JSON.stringify(cookies))
    return filePath
  }

  it('imports a validated custom domain without touching unrelated target cookies', async () => {
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.example.com',
        name: 'old-custom',
        value: 'old',
        path: '/',
        secure: true
      },
      { domain: '.other.com', name: 'keep-other', value: 'keep', path: '/', secure: true }
    ])
    const filePath = writeCookieFile([
      { domain: '.example.com', name: 'new-custom', value: 'new', secure: true },
      { domain: '.other.com', name: 'other-source', value: 'other', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test', undefined, {
      label: 'Example AI',
      domains: ['example.com'],
      sourceHostname: 'chat.example.com'
    })

    expect(result.ok).toBe(true)
    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    expect(cookiesRemoveMock).toHaveBeenCalledWith('https://example.com/', 'old-custom')
    expect(cookiesRemoveMock).not.toHaveBeenCalledWith(expect.any(String), 'keep-other')
  })

  it('preserves existing scoped cookies when every replacement set fails', async () => {
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.chatgpt.com',
        name: 'existing',
        value: 'keep',
        path: '/',
        secure: true
      }
    ])
    cookiesSetMock.mockRejectedValue(new Error('set failed'))
    const filePath = writeCookieFile([
      { domain: '.chatgpt.com', name: 'replacement', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test', 'chatgpt')

    expect(result).toEqual({
      ok: false,
      reason: 'Could not safely replace existing ChatGPT cookies.'
    })
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
  })

  it('rolls back a partial scoped set failure', async () => {
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.chatgpt.com',
        name: 'existing',
        value: 'keep',
        path: '/',
        secure: true
      }
    ])
    cookiesSetMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('set failed'))
    const filePath = writeCookieFile([
      { domain: '.chatgpt.com', name: 'replacement-1', value: 'one', secure: true },
      { domain: '.chatgpt.com', name: 'replacement-2', value: 'two', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test', 'chatgpt')

    expect(result.ok).toBe(false)
    expect(cookiesRemoveMock).toHaveBeenCalled()
    expect(cookiesSetMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'existing', value: 'keep' })
    )
  })

  it('does not let an expired source cookie delete a valid target identity', async () => {
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.chatgpt.com',
        name: 'keep-session',
        value: 'valid-target',
        path: '/',
        secure: true
      },
      {
        domain: '.chatgpt.com',
        name: 'stale-target',
        value: 'stale',
        path: '/',
        secure: true
      }
    ])
    const filePath = writeCookieFile([
      {
        domain: '.chatgpt.com',
        name: 'keep-session',
        value: 'expired-source',
        secure: true,
        expirationDate: Math.floor(Date.now() / 1000) - 60
      },
      { domain: '.chatgpt.com', name: 'new-session', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test', 'chatgpt')

    expect(result.ok).toBe(true)
    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    expect(cookiesRemoveMock).toHaveBeenCalledWith('https://chatgpt.com/', 'stale-target')
    expect(cookiesRemoveMock).not.toHaveBeenCalledWith(expect.any(String), 'keep-session')
  })
})

describe('scoped Chromium cookie replacement safety', () => {
  let tmpDir: string
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-scope-chromium-test-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    copyFileSyncMock.mockClear()
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => {
      throw new Error('OS credential commands are unavailable in this test')
    })
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: cookiesGetMock,
        set: cookiesSetMock,
        remove: cookiesRemoveMock,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearStorageData: vi.fn().mockResolvedValue(undefined)
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function targetCookiesPath(): string {
    return join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
  }

  it('imports a validated custom scope from Chromium', async () => {
    const sourcePath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourcePath, [
      { name: 'custom-new', value: 'new', hostKey: '.example.com', secure: true },
      { name: 'other-source', value: 'other', hostKey: '.other.com', secure: true }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath(), [
      { name: 'custom-old', value: 'old', hostKey: '.example.com', secure: true },
      { name: 'other-keep', value: 'keep', hostKey: '.other.com', secure: true }
    ]).close()
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.example.com',
        name: 'custom-old',
        value: 'old',
        path: '/',
        secure: true
      },
      { domain: '.other.com', name: 'other-keep', value: 'keep', path: '/', secure: true }
    ])

    const result = await importCookiesFromBrowser(
      chromeBrowser(sourcePath),
      'persist:test',
      undefined,
      {
        label: 'Example AI',
        domains: ['example.com'],
        sourceHostname: 'chat.example.com'
      }
    )

    expect(result.ok).toBe(true)
    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    expect(cookiesRemoveMock).toHaveBeenCalledWith('https://example.com/', 'custom-old')
    expect(cookiesRemoveMock).not.toHaveBeenCalledWith(expect.any(String), 'other-keep')
  })

  it('preserves live scoped cookies when every Chromium set fails', async () => {
    const sourcePath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourcePath, [
      { name: 'chatgpt-new', value: 'new', hostKey: '.chatgpt.com', secure: true }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath(), [
      { name: 'chatgpt-old', value: 'keep', hostKey: '.chatgpt.com', secure: true }
    ]).close()
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.chatgpt.com',
        name: 'chatgpt-old',
        value: 'keep',
        path: '/',
        secure: true
      }
    ])
    cookiesSetMock.mockRejectedValue(new Error('set failed'))

    const result = await importCookiesFromBrowser(
      chromeBrowser(sourcePath),
      'persist:test',
      'chatgpt'
    )

    expect(result).toEqual({
      ok: false,
      reason: 'Could not safely replace existing ChatGPT cookies.'
    })
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
  })

  it('aborts when any relevant Chromium cookie cannot be decrypted', async () => {
    const sourcePath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourcePath, [
      { name: 'plain', value: 'plain', hostKey: '.chatgpt.com', secure: true },
      {
        name: 'bound',
        value: '',
        encryptedValue: Buffer.from('v10-invalid-ciphertext'),
        hostKey: '.chatgpt.com',
        secure: true
      }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath(), [
      { name: 'chatgpt-old', value: 'keep', hostKey: '.chatgpt.com', secure: true }
    ]).close()
    execFileSyncMock.mockReturnValue('test-password\n')
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourcePath),
        'persist:test',
        'chatgpt'
      )

      expect(result).toEqual({
        ok: false,
        reason: 'Could not prepare all ChatGPT cookies from Google Chrome.'
      })
      expect(cookiesGetMock).not.toHaveBeenCalled()
      expect(cookiesSetMock).not.toHaveBeenCalled()
      expect(cookiesRemoveMock).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('preserves a valid target when the same Chromium source identity is expired', async () => {
    const sourcePath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourcePath, [
      {
        name: 'keep-session',
        value: 'expired-source',
        hostKey: '.chatgpt.com',
        secure: true,
        expirationDate: Math.floor(Date.now() / 1000) - 60
      },
      { name: 'new-session', value: 'new', hostKey: '.chatgpt.com', secure: true }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath(), [
      { name: 'keep-session', value: 'valid-target', hostKey: '.chatgpt.com', secure: true },
      { name: 'stale-target', value: 'stale', hostKey: '.chatgpt.com', secure: true }
    ]).close()
    cookiesGetMock.mockResolvedValue([
      {
        domain: '.chatgpt.com',
        name: 'keep-session',
        value: 'valid-target',
        path: '/',
        secure: true
      },
      {
        domain: '.chatgpt.com',
        name: 'stale-target',
        value: 'stale',
        path: '/',
        secure: true
      }
    ])

    const result = await importCookiesFromBrowser(
      chromeBrowser(sourcePath),
      'persist:test',
      'chatgpt'
    )

    expect(result.ok).toBe(true)
    expect(cookiesSetMock).toHaveBeenCalledTimes(1)
    expect(cookiesRemoveMock).toHaveBeenCalledWith('https://chatgpt.com/', 'stale-target')
    expect(cookiesRemoveMock).not.toHaveBeenCalledWith(expect.any(String), 'keep-session')
  })
})
