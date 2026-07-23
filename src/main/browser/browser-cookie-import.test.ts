import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  copyFileSyncMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn()
}))

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
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

import {
  buildChromiumCookieInsertParams,
  CHROMIUM_LOCAL_STATE_MAX_BYTES,
  importCookiesFromFile,
  importCookiesFromBrowser,
  detectInstalledBrowsers,
  summarizeCookieImportError,
  type ChromiumCookieColumnInfo,
  type DetectedBrowser
} from './browser-cookie-import'
import {
  createChromiumCookieTestDatabase,
  encryptMacChromiumCookie
} from './browser-cookie-import-test-database'
import { COOKIE_JSON_FILE_MAX_BYTES } from './browser-cookie-json-file-parser'
import { INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES } from './installed-browser-cookie-store-limits'
import { SAFARI_COOKIE_STORE_MAX_FILE_BYTES } from './safari-cookie-store-decoder'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
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

function firefoxBrowser(cookiesPath: string): DetectedBrowser {
  return {
    family: 'firefox',
    label: 'Firefox',
    cookiesPath,
    profiles: [{ name: 'default', directory: 'default' }],
    selectedProfile: 'default'
  }
}

function createFirefoxCookieTestDatabase(
  databasePath: string,
  rows: { name: string; value: string; host: string }[]
): void {
  const database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE moz_cookies (
      name TEXT,
      value TEXT,
      host TEXT,
      path TEXT,
      expiry INTEGER,
      isSecure INTEGER,
      isHttpOnly INTEGER,
      sameSite INTEGER
    )
  `)
  const insert = database.prepare('INSERT INTO moz_cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const row of rows) {
    insert.run(row.name, row.value, row.host, '/', 2_000_000_000, 0, 0, 0)
  }
  database.close()
}

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
  let cookiesSetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { set: cookiesSetMock }
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

    expect(cookiesSetMock).toHaveBeenCalledTimes(2)
    const firstCall = cookiesSetMock.mock.calls[0][0]
    expect(firstCall.name).toBe('_gh_sess')
    expect(firstCall.domain).toBe('.github.com')
    expect(firstCall.secure).toBe(true)
    expect(firstCall.sameSite).toBe('lax')
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

  it('rejects an oversized JSON file before reading its bytes', async () => {
    const filePath = join(tmpDir, 'oversized.json')
    writeFileSync(filePath, '')
    truncateSync(filePath, COOKIE_JSON_FILE_MAX_BYTES + 1)

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result).toEqual({
      ok: false,
      reason: 'Cookie file is too large to import safely (64 MiB file limit).'
    })
    expect(sessionFromPartitionMock).not.toHaveBeenCalled()
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

    expect(cookiesSetMock.mock.calls[0][0].sameSite).toBe('no_restriction')
    expect(cookiesSetMock.mock.calls[1][0].sameSite).toBe('lax')
    expect(cookiesSetMock.mock.calls[2][0].sameSite).toBe('strict')
    expect(cookiesSetMock.mock.calls[3][0].sameSite).toBe('unspecified')
    expect(cookiesSetMock.mock.calls[4][0].sameSite).toBe('unspecified')
  })

  it('derives correct URL from domain and secure flag', async () => {
    const filePath = writeCookieFile([
      { domain: '.secure.com', name: 'a', value: '1', secure: true },
      { domain: '.insecure.com', name: 'b', value: '2', secure: false },
      { domain: 'nodot.com', name: 'c', value: '3' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookiesSetMock.mock.calls[0][0].url).toBe('https://secure.com/')
    expect(cookiesSetMock.mock.calls[1][0].url).toBe('http://insecure.com/')
    expect(cookiesSetMock.mock.calls[2][0].url).toBe('http://nodot.com/')
  })

  it('counts cookies that fail to set', async () => {
    cookiesSetMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('set failed'))

    const filePath = writeCookieFile([
      { domain: '.a.com', name: 'ok', value: '1' },
      { domain: '.b.com', name: 'fail', value: '2' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.skippedCookies).toBe(1)
  })
})

describe('importCookiesFromBrowser Safari', () => {
  let tmpDir: string
  let cookiesSetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-safari-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { set: cookiesSetMock }
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
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('rejects an oversized Safari store before reading its bytes', async () => {
    const cookiesPath = join(tmpDir, 'Cookies.binarycookies')
    writeFileSync(cookiesPath, '')
    truncateSync(cookiesPath, SAFARI_COOKIE_STORE_MAX_FILE_BYTES + 1)
    const browser: DetectedBrowser = {
      family: 'safari',
      label: 'Safari',
      cookiesPath,
      profiles: [],
      selectedProfile: 'Default'
    }

    const result = await importCookiesFromBrowser(browser, 'persist:test')

    expect(result).toEqual({
      ok: false,
      reason: 'Safari cookie store is too large to import safely (64 MiB file limit).'
    })
    expect(sessionFromPartitionMock).not.toHaveBeenCalled()
  })
})

describe('importCookiesFromBrowser Firefox', () => {
  let tmpDir: string
  let cookiesSetMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-firefox-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: { set: cookiesSetMock }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('streams ordinary cookies in source order without changing the summary', async () => {
    const cookiesPath = join(tmpDir, 'cookies.sqlite')
    createFirefoxCookieTestDatabase(cookiesPath, [
      { name: 'first', value: 'one', host: '.first.example.com' },
      { name: 'second', value: 'two', host: '.second.example.com' }
    ])

    const result = await importCookiesFromBrowser(firefoxBrowser(cookiesPath), 'persist:test')

    expect(result).toEqual({
      ok: true,
      profileId: '',
      summary: {
        totalCookies: 2,
        importedCookies: 2,
        skippedCookies: 0,
        domains: ['first.example.com', 'second.example.com']
      }
    })
    expect(cookiesSetMock.mock.calls.map(([cookie]) => cookie.name)).toEqual(['first', 'second'])
  })

  it('rejects oversized cookie data before iterating or mutating the target session', async () => {
    const cookiesPath = join(tmpDir, 'cookies.sqlite')
    const database = new DatabaseSync(cookiesPath)
    database.exec(`
      CREATE VIEW moz_cookies AS
      SELECT
        'sid' AS name,
        zeroblob(${INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES + 1}) AS value,
        '.example.com' AS host,
        '/' AS path,
        0 AS expiry,
        0 AS isSecure,
        0 AS isHttpOnly,
        0 AS sameSite
    `)
    database.close()

    const result = await importCookiesFromBrowser(firefoxBrowser(cookiesPath), 'persist:test')

    expect(result).toEqual({
      ok: false,
      reason:
        'Firefox cookie store is too large to import safely (250,000-cookie and 64 MiB cookie-data limits).'
    })
    expect(sessionFromPartitionMock).not.toHaveBeenCalled()
  })
})

describe('importCookiesFromBrowser Chromium', () => {
  let tmpDir: string
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesFlushStoreMock: ReturnType<typeof vi.fn>
  let clearStorageDataMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-chromium-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesFlushStoreMock = vi.fn().mockResolvedValue(undefined)
    clearStorageDataMock = vi.fn().mockResolvedValue(undefined)
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
        set: cookiesSetMock,
        remove: cookiesRemoveMock,
        flushStore: cookiesFlushStoreMock
      },
      clearStorageData: clearStorageDataMock
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('imports from a live Chromium source DB into a Network/Cookies target profile', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    // Why: keeping the writer open leaves the committed row in WAL, matching a
    // running Chromium profile whose latest auth cookies are not checkpointed.
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
      expect(cookiesSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: '.example.com',
          name: 'sid',
          value: 'source-value'
        })
      )
      expect(execFileSyncMock.mock.calls.some(([command]) => command === 'security')).toBe(false)
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
      expect(clearStorageDataMock).toHaveBeenCalledWith({ storages: ['cookies'] })
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
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'security') {
        return `${password}\n`
      }
      throw new Error(`Unexpected command: ${command}`)
    })
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledWith(
        'security',
        expect.any(Array),
        expect.any(Object)
      )
      expect(cookiesSetMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'encrypted-value' })
      )
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('removes staging data when the OS key is unavailable', async () => {
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
      expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('removes partial staging data when the target database copy fails', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, []).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    copyFileSyncMock.mockImplementationOnce((_source: string, destination: string) => {
      writeFileSync(destination, 'partial cookie database')
      throw new Error('simulated copy failure')
    })

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result).toEqual({ ok: false, reason: 'Could not create staging cookie database.' })
    expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
  })

  it('rejects oversized source data before decrypting or clearing target cookies', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    mkdirSync(join(sourceCookiesPath, '..'), { recursive: true })
    const sourceDatabase = new DatabaseSync(sourceCookiesPath)
    sourceDatabase.exec(`
      CREATE VIEW cookies AS
      SELECT
        1 AS creation_utc,
        '.example.com' AS host_key,
        '' AS top_frame_site_key,
        'sid' AS name,
        zeroblob(${INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES + 1}) AS value,
        X'' AS encrypted_value,
        '/' AS path,
        0 AS expires_utc,
        0 AS is_secure,
        0 AS is_httponly,
        0 AS samesite,
        0 AS source_scheme,
        -1 AS source_port,
        0 AS last_update_utc,
        0 AS has_cross_site_ancestor
    `)
    sourceDatabase.close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result).toEqual({
      ok: false,
      reason:
        'Google Chrome cookie store is too large to import safely (250,000-cookie and 64 MiB cookie-data limits).'
    })
    expect(clearStorageDataMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
    expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
  })
})

describe('detectInstalledBrowsers', () => {
  it('falls back safely when Chromium Local State exceeds its read cap', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-browser-detection-bounds-'))
    const originalConfigHome = process.env.XDG_CONFIG_HOME
    const originalPlatform = process.platform
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      process.env.XDG_CONFIG_HOME = root
      const browserRoot = join(root, 'google-chrome')
      mkdirSync(join(browserRoot, 'Default'), { recursive: true })
      writeFileSync(join(browserRoot, 'Default', 'Cookies'), '')
      writeFileSync(join(browserRoot, 'Local State'), '')
      truncateSync(join(browserRoot, 'Local State'), CHROMIUM_LOCAL_STATE_MAX_BYTES + 1)

      const chrome = detectInstalledBrowsers().find((browser) => browser.family === 'chrome')

      expect(chrome?.profiles).toEqual([{ name: 'Default', directory: 'Default' }])
      expect(chrome?.selectedProfile).toBe('Default')
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
      if (originalConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = originalConfigHome
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns an array of detected browsers', () => {
    const browsers = detectInstalledBrowsers()
    expect(Array.isArray(browsers)).toBe(true)
    for (const browser of browsers) {
      expect(browser).toHaveProperty('family')
      expect(browser).toHaveProperty('label')
      expect(browser).toHaveProperty('cookiesPath')
      // keychainService/keychainAccount are only present for Chromium-based browsers
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
      'helium'
    ]
    for (const browser of browsers) {
      expect(validFamilies).toContain(browser.family)
    }
  })
})

describe('buildChromiumCookieInsertParams', () => {
  it('fills target-only NOT NULL Chromium cookie columns instead of inserting null', () => {
    const decryptedValue = Buffer.from('decrypted-cookie-value')
    const columns: ChromiumCookieColumnInfo[] = [
      { name: 'creation_utc', type: 'INTEGER', notnull: 1 },
      { name: 'host_key', type: 'TEXT', notnull: 1 },
      { name: 'top_frame_site_key', type: 'TEXT', notnull: 1 },
      { name: 'name', type: 'TEXT', notnull: 1 },
      { name: 'value', type: 'TEXT', notnull: 1 },
      { name: 'encrypted_value', type: 'BLOB', notnull: 1 },
      { name: 'source_port', type: 'INTEGER', notnull: 1 },
      { name: 'last_update_utc', type: 'INTEGER', notnull: 1 },
      { name: 'has_cross_site_ancestor', type: 'INTEGER', notnull: 1, dflt_value: '0' }
    ]
    const sourceRow = {
      creation_utc: 133_000_000_000_000n,
      host_key: '.example.com',
      name: 'sid'
    }

    const params = buildChromiumCookieInsertParams(columns, sourceRow, decryptedValue)

    expect(params).toEqual([
      133_000_000_000_000n,
      '.example.com',
      '',
      'sid',
      decryptedValue,
      Buffer.alloc(0),
      -1,
      133_000_000_000_000n,
      0
    ])
  })

  it('preserves null for nullable columns without defaults', () => {
    const decryptedValue = Buffer.from('decrypted-cookie-value')
    const columns: ChromiumCookieColumnInfo[] = [
      { name: 'creation_utc', type: 'INTEGER', notnull: 1 },
      { name: 'host_key', type: 'TEXT', notnull: 1 },
      { name: 'nullable_metadata', type: 'TEXT', notnull: 0 },
      { name: 'target_only_nullable_metadata', type: 'TEXT', notnull: 0 },
      { name: 'last_update_utc', type: 'INTEGER', notnull: 1 }
    ]
    const sourceRow = {
      creation_utc: 133_000_000_000_000n,
      host_key: '.example.com',
      nullable_metadata: null
    }

    const params = buildChromiumCookieInsertParams(columns, sourceRow, decryptedValue)

    expect(params).toEqual([133_000_000_000_000n, '.example.com', null, null, 133_000_000_000_000n])
  })
})
