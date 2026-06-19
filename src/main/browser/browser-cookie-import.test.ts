/* eslint-disable max-lines -- Why: cookie import tests share import-time Electron mocks plus
   browser-specific cookie fixtures; splitting would duplicate brittle setup. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionFromPartitionMock, dialogShowOpenDialogMock } = vi.hoisted(() => ({
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

import {
  buildChromiumCookieInsertParams,
  importCookiesFromFile,
  importCookiesFromBrowser,
  detectInstalledBrowsers,
  summarizeCookieImportError,
  type ChromiumCookieColumnInfo,
  type DetectedBrowser
} from './browser-cookie-import'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
})

describe('detectInstalledBrowsers', () => {
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
    const validFamilies = ['chrome', 'edge', 'arc', 'chromium', 'firefox', 'safari', 'comet']
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
