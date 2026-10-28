import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  copyFileSyncMock,
  runProcessSyncMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  runProcessSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn()
}))

vi.mock('../browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))

// Mock credential output at the process wrapper; it owns timeouts and console hiding.
vi.mock('@orca/process-host', () => ({
  runProcessSync: runProcessSyncMock
}))
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
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: CookiesGetFilter) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
    }
  }) => ({
    get: (filter: CookiesGetFilter) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie, url }) => ({ url, ...cookie })),
    restoreClearIdentities: async () => undefined,
    // Implement CDP writes so swallowed missing-method errors cannot fake successful coverage.
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import {
  importCookiesFromFile,
  importCookiesFromBrowser,
  detectInstalledBrowsers
} from './browser-cookie-import'
import type { DetectedBrowser } from './sources/browser-cookie-detection-types'

import { summarizeCookieImportError } from './browser-cookie-import-diagnostics'

import {
  createChromiumCookieTestDatabase,
  encryptMacChromiumCookie
} from './browser-cookie-import-test-database'
import { existsSync, writeFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

// Only the initialization probe may use cookies.set; user cookies require CDP partition identities.
const unreachableCookieSet = vi.fn(async (details: { name: string }) => {
  if (details.name !== '__init') {
    throw new Error(`cookies.set was called for user cookie ${details.name}`)
  }
})

const LARGE_SAFARI_COOKIE_COUNT = 150_000

describe('summarizeCookieImportError', () => {
  it('folds a bounded error preview without full-string whitespace replacement', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const message = `Import failed\n\t${'secret-cookie-value '.repeat(20_000)}`

    const summary = summarizeCookieImportError(new Error(message))

    expect(summary.length).toBeLessThanOrEqual(180)
    expect(summary).toContain('Import failed secret-cookie-value')
    expect(replaceSpy).not.toHaveBeenCalled()
  })
})

function buildSafariBinaryCookies(cookieCount: number): Buffer {
  const cookies: Buffer[] = []
  const offsets: number[] = []
  let pageSize = 8 + cookieCount * 4

  for (let index = 0; index < cookieCount; index += 1) {
    offsets.push(pageSize)
    const cookie = buildExpiredSafariCookie(index)
    cookies.push(cookie)
    pageSize += cookie.length
  }

  const page = Buffer.alloc(pageSize)
  page.writeUInt32BE(0x00000100, 0)
  page.writeUInt32LE(cookieCount, 4)
  for (let index = 0; index < offsets.length; index += 1) {
    page.writeUInt32LE(offsets[index], 8 + index * 4)
  }

  let cookieOffset = 8 + cookieCount * 4
  for (const cookie of cookies) {
    cookie.copy(page, cookieOffset)
    cookieOffset += cookie.length
  }

  const file = Buffer.alloc(12 + page.length)
  file.write('cook', 0, 'utf8')
  file.writeUInt32BE(1, 4)
  file.writeUInt32BE(page.length, 8)
  page.copy(file, 12)
  return file
}

function buildExpiredSafariCookie(index: number): Buffer {
  const domain = `.expired-${index}.example.com`
  const name = `sid-${index}`
  const path = '/'
  const value = 'expired'
  const strings = [domain, name, path, value]
  const headerSize = 48
  let cursor = headerSize
  const offsets = strings.map((text) => {
    const offset = cursor
    cursor += Buffer.byteLength(text) + 1
    return offset
  })

  const cookie = Buffer.alloc(cursor)
  cookie.writeUInt32LE(cookie.length, 0)
  cookie.writeUInt32LE(offsets[0], 16)
  cookie.writeUInt32LE(offsets[1], 20)
  cookie.writeUInt32LE(offsets[2], 24)
  cookie.writeUInt32LE(offsets[3], 28)
  cookie.writeDoubleLE(1, 40)
  for (let index = 0; index < strings.length; index += 1) {
    cookie.write(strings[index], offsets[index], 'utf8')
  }
  return cookie
}

describe('importCookiesFromFile', () => {
  let tmpDir: string
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookieWriteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-test-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookieWriteMock = writeCookieIdentityMock
    cookieWriteMock.mockReset()
    cookieWriteMock.mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: cookiesGetMock,
        remove: cookiesRemoveMock,
        set: unreachableCookieSet
      }
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

  it('imports valid cookies', async () => {
    const filePath = writeCookieFile([
      {
        domain: '.github.com',
        name: '_gh_sess',
        value: 'abc123',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1800000000
      },
      {
        domain: '.example.com',
        name: 'test',
        value: 'val',
        path: '/',
        secure: false,
        httpOnly: false
      }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.summary.totalCookies).toBe(2)
    expect(result.summary.importedCookies).toBe(2)
    expect(result.summary.skippedCookies).toBe(0)
    expect(result.summary.domains).toContain('github.com')
    expect(result.summary.domains).toContain('example.com')

    expect(cookieWriteMock).toHaveBeenCalledTimes(2)
    const firstCall = cookieWriteMock.mock.calls[0][0]
    expect(firstCall.name).toBe('_gh_sess')
    expect(firstCall.domain).toBe('.github.com')
    expect(firstCall.secure).toBe(true)
    expect(firstCall.sameSite).toBe('lax')
  })

  it('sets __Host- cookies host-only so Chromium does not reject them', async () => {
    const filePath = writeCookieFile([
      {
        domain: 'github.com',
        name: '__Host-user_session_same_site',
        value: 'sess',
        path: '/account',
        secure: true,
        httpOnly: true,
        sameSite: 'lax'
      },
      { domain: '.github.com', name: '_gh_sess', value: 'abc', path: '/settings', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)

    const hostCall = cookieWriteMock.mock.calls
      .map((c) => c[0])
      .find((c) => c.name === '__Host-user_session_same_site')
    expect(hostCall.hostOnly).toBe(true)
    expect(hostCall.path).toBe('/')

    const normalCall = cookieWriteMock.mock.calls
      .map((c) => c[0])
      .find((c) => c.name === '_gh_sess')
    expect(normalCall.hostOnly).toBe(false)
    expect(normalCall.domain).toBe('.github.com')
    expect(normalCall.path).toBe('/settings')
  })

  it('rejects non-JSON files', async () => {
    const filePath = join(tmpDir, 'bad.json')
    writeFileSync(filePath, 'not json at all')

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('not valid JSON')
  })

  it('rejects non-array JSON', async () => {
    const filePath = join(tmpDir, 'object.json')
    writeFileSync(filePath, '{"domain": "test.com"}')

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('JSON array')
  })

  it('rejects empty array', async () => {
    const filePath = writeCookieFile([])
    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('empty')
  })

  it('skips entries with missing required fields', async () => {
    const filePath = writeCookieFile([
      { domain: '.valid.com', name: 'ok', value: 'val' },
      { name: 'no-domain', value: 'val' },
      { domain: '.valid2.com', value: 'no-name' },
      { domain: '.valid3.com', name: 'no-value' },
      'not an object',
      42
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.skippedCookies).toBe(5)
  })

  it('reports all skipped when no valid cookies', async () => {
    const filePath = writeCookieFile([
      { name: 'no-domain', value: 'val' },
      { domain: '', name: 'empty-domain', value: 'val' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('No valid cookies')
    expect(result.reason).toContain('2 entries were skipped')
  })

  it('handles file read errors', async () => {
    const result = await importCookiesFromFile('/nonexistent/path.json', 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('Could not read')
  })

  it('normalizes sameSite values', async () => {
    const filePath = writeCookieFile([
      { domain: '.test.com', name: 'a', value: '1', sameSite: 'None' },
      { domain: '.test.com', name: 'b', value: '2', sameSite: 'Lax' },
      { domain: '.test.com', name: 'c', value: '3', sameSite: 'Strict' },
      { domain: '.test.com', name: 'd', value: '4', sameSite: 'unknown' },
      { domain: '.test.com', name: 'e', value: '5' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookieWriteMock.mock.calls[0][0].sameSite).toBe('no_restriction')
    expect(cookieWriteMock.mock.calls[1][0].sameSite).toBe('lax')
    expect(cookieWriteMock.mock.calls[2][0].sameSite).toBe('strict')
    expect(cookieWriteMock.mock.calls[3][0].sameSite).toBe('unspecified')
    expect(cookieWriteMock.mock.calls[4][0].sameSite).toBe('unspecified')
  })

  it('derives correct URL from domain and secure flag', async () => {
    const filePath = writeCookieFile([
      { domain: '.secure.com', name: 'a', value: '1', secure: true },
      { domain: '.insecure.com', name: 'b', value: '2', secure: false },
      { domain: 'nodot.com', name: 'c', value: '3' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookieWriteMock.mock.calls[0][0].url).toBe('https://secure.com/')
    expect(cookieWriteMock.mock.calls[1][0].url).toBe('http://insecure.com/')
    expect(cookieWriteMock.mock.calls[2][0].url).toBe('http://nodot.com/')
  })

  it('counts a rejected row while keeping successful writes', async () => {
    cookieWriteMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('set failed'))

    const filePath = writeCookieFile([
      { domain: '.a.com', name: 'ok', value: '1' },
      { domain: '.b.com', name: 'fail', value: '2' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result).toMatchObject({ ok: true, summary: { importedCookies: 1, skippedCookies: 1 } })
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
  })
})

describe('importCookiesFromBrowser Safari', () => {
  let tmpDir: string
  let cookieWriteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-safari-cookie-test-'))
    cookieWriteMock = writeCookieIdentityMock
    cookieWriteMock.mockReset()
    cookieWriteMock.mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { set: unreachableCookieSet }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('reports expired cookies from large Safari binary cookie pages', async () => {
    const cookiesPath = join(tmpDir, 'Cookies.binarycookies')
    writeFileSync(cookiesPath, buildSafariBinaryCookies(LARGE_SAFARI_COOKIE_COUNT))
    const browser: DetectedBrowser = {
      family: 'safari',
      label: 'Safari',
      cookiesPath,
      profiles: [],
      selectedProfile: 'Default'
    }

    const result = await importCookiesFromBrowser(browser, 'persist:test')

    expect(result).toEqual({ ok: false, reason: 'All Safari cookies are expired.' })
    expect(cookieWriteMock).not.toHaveBeenCalled()
  })
})

describe('importCookiesFromBrowser Chromium', () => {
  let tmpDir: string
  let cookieWriteMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesFlushStoreMock: ReturnType<typeof vi.fn>
  let clearDataMock: ReturnType<typeof vi.fn>
  let setUserAgentMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-chromium-cookie-test-'))
    cookieWriteMock = writeCookieIdentityMock
    cookieWriteMock.mockReset()
    cookieWriteMock.mockResolvedValue(undefined)
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesFlushStoreMock = vi.fn().mockResolvedValue(undefined)
    clearDataMock = vi.fn().mockResolvedValue(undefined)
    setUserAgentMock = vi.fn()
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    copyFileSyncMock.mockClear()
    setPendingCookieImportMock.mockClear()
    clearPendingCookieImportMock.mockClear()
    runProcessSyncMock.mockReset()
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('OS credential commands are unavailable in this test')
    })
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        set: unreachableCookieSet,
        remove: cookiesRemoveMock,
        flushStore: cookiesFlushStoreMock
      },
      clearData: clearDataMock,
      setUserAgent: setUserAgentMock,
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })
  it('imports from a live Chromium source DB into a Network/Cookies target profile', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    // Keep the writer open so committed cookies remain in WAL, as in a running browser.
    const sourceDb = createChromiumCookieTestDatabase(
      sourceCookiesPath,
      [{ name: 'sid', value: 'source-value' }],
      { journalMode: 'wal' }
    )
    createChromiumCookieTestDatabase(targetCookiesPath, [
      { name: 'old', value: 'target-value' }
    ]).close()

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      expect(existsSync(`${sourceCookiesPath}-wal`)).toBe(true)
      const sourceFilesBefore = ['', '-wal', '-shm'].map((suffix) =>
        readFileSync(sourceCookiesPath + suffix)
      )

      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(cookieWriteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: '.example.com',
          name: 'sid',
          value: 'source-value'
        })
      )
      expect(runProcessSyncMock).not.toHaveBeenCalled()
      expect(copyFileSyncMock.mock.calls.some(([source]) => source === sourceCookiesPath)).toBe(
        true
      )
      expect(
        copyFileSyncMock.mock.calls.some(([source]) => source === `${sourceCookiesPath}-wal`)
      ).toBe(true)
      expect(
        ['', '-wal', '-shm'].map((suffix) => readFileSync(sourceCookiesPath + suffix))
      ).toEqual(sourceFilesBefore)
      expect(cookiesRemoveMock).not.toHaveBeenCalled()
      expect(clearDataMock).not.toHaveBeenCalled()
      // Import must retain the registry’s user agent rather than impersonating the source browser.
      expect(setUserAgentMock).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
      sourceDb.close()
    }
  })

  it('uses the OS key for encrypted Chromium rows', async () => {
    const password = 'test-password'
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        name: 'sid',
        value: '',
        encryptedValue: encryptMacChromiumCookie('encrypted-value', password)
      }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    runProcessSyncMock.mockReturnValue({
      code: 0,
      signal: null,
      stdout: `${password}\n`,
      stderr: '',
      timedOut: false
    })
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledWith({
        program: 'security',
        args: ['find-generic-password', '-s', 'Chrome Safe Storage', '-a', 'Chrome', '-w'],
        timeoutMs: 30_000
      })
      expect(cookieWriteMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'encrypted-value' })
      )
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('leaves no staging data when the OS key is unavailable', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: '', encryptedValue: Buffer.from('v10-encrypted') }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(false)
      expect(existsSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toBe(false)
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('retires pending replay once after native live completion', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      expect(clearPendingCookieImportMock).toHaveBeenCalledExactlyOnceWith('persist:test')
      expect(result.ok && result.summary?.warning).toBeUndefined()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('skips an oversized rejected row on a fresh target without producing replay', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.failed.example', name: 'oversized', value: 'v'.repeat(4096) },
      { domain: '.good.example', name: 'sid', value: 'source-value' }
    ]).close()
    cookieWriteMock.mockRejectedValueOnce(new Error('cookie rejected'))
    // A new profile need not have a storage path or Cookies database to accept live writes.
    sessionFromPartitionMock.mockReturnValue({
      cookies: { flushStore: cookiesFlushStoreMock },
      getStoragePath: vi.fn(() => {
        throw new Error('target storage must not be read')
      })
    })
    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')
    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      domains: ['good.example']
    })
    expect(result.ok && result.summary.warning).toBeUndefined()
    expect(cookieWriteMock).toHaveBeenCalledTimes(2)
    expect(cookiesFlushStoreMock).toHaveBeenCalledOnce()
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
    expect(clearPendingCookieImportMock).toHaveBeenCalledExactlyOnceWith('persist:test')
    expect(existsSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toBe(false)
    expect(copyFileSyncMock.mock.calls.every(([source]) => source === sourceCookiesPath)).toBe(true)
  })
})

describe('detectInstalledBrowsers', () => {
  it('returns an array of detected browsers', () => {
    const browsers = detectInstalledBrowsers()
    expect(Array.isArray(browsers)).toBe(true)
    for (const browser of browsers) {
      expect(browser).toHaveProperty('family')
      expect(browser).toHaveProperty('label')
      expect(browser).toHaveProperty('cookiesPath')
      if (['chrome', 'edge', 'arc', 'chromium'].includes(browser.family)) {
        expect(browser).toHaveProperty('keychainService')
        expect(browser).toHaveProperty('keychainAccount')
      }
    }
  })

  it('each detected browser has a valid family', () => {
    const browsers = detectInstalledBrowsers()
    const validFamilies = [
      'chrome',
      'edge',
      'arc',
      'chromium',
      'firefox',
      'safari',
      'comet',
      'helium',
      'vivaldi'
    ]
    for (const browser of browsers) {
      expect(validFamilies).toContain(browser.family)
    }
  })
})
