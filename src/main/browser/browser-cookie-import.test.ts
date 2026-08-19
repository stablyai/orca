import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  copyFileSyncMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn()
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
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
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: object) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
    }
  }) => ({
    get: (filter: object) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie, url }) => ({ url, ...cookie })),
    restoreClearIdentities: async () => undefined,
    // Why (STA-4300): the import writes land here, not on cookies.set. A store mock missing this
    // method would throw a TypeError the per-cookie catch swallows, quietly turning every write
    // into a "rejected cookie" while the suite still looked green.
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
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
import {
  createChromiumCookieTestDatabase,
  encryptMacChromiumCookie
} from './browser-cookie-import-test-database'
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'node:fs'
import { dirname, join } from 'node:path'
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

// Why (STA-4300): cookies.set() silently drops partitionKey, so no user cookie may reach it. Only
// the __init probe — which writes no user data — is allowed through; anything else is the
// downgrade returning, and it must fail the test rather than quietly succeed.
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
    // __Host- prefix requires no Domain attribute and path=/, or Chromium drops it. hostOnly is how
    // the identity says "omit domain"; cdpSetCookieParamsFromIdentity drops it on the wire.
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

  it('rolls back replacement when a cookie fails to set', async () => {
    cookieWriteMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('set failed'))

    const filePath = writeCookieFile([
      { domain: '.a.com', name: 'ok', value: '1' },
      { domain: '.b.com', name: 'fail', value: '2' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    expect(cookiesRemoveMock).toHaveBeenCalledWith('http://a.com/', 'ok')
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
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => {
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
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === 'defaults') {
        return '120.0.6099.71\n'
      }
      throw new Error(`Unexpected command: ${command}`)
    })
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
      expect(execFileSyncMock.mock.calls.some(([command]) => command === 'security')).toBe(false)
      expect(execFileSyncMock.mock.calls.some(([command]) => command === 'defaults')).toBe(false)
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
      // Why: STA-3514 — imports must never impersonate the source browser; the
      // session keeps the engine UA the registry set at startup.
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
      expect(cookieWriteMock).toHaveBeenCalledWith(
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

  // Why: #9355 — staging only backs the cold-restart replay, so an AV/EDR handle that blocks
  // the staging copy must degrade that fallback, not abort an import the memory path can serve.
  it('still imports in-memory when the target database copy fails', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    // The staging copy runs before the source snapshot, so the first copy is the staging one.
    copyFileSyncMock.mockImplementationOnce((_source: string, destination: string) => {
      writeFileSync(destination, 'partial cookie database')
      const error = new Error('EBUSY: resource busy or locked, copyfile') as NodeJS.ErrnoException
      error.code = 'EBUSY'
      throw error
    })

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(cookieWriteMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'source-value' })
      )
      // The partial staging file is still discarded, so no stale DB replays on cold start.
      expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: #9355 — the staged file is also named "Cookies", so the same transient handle can make
  // opening it throw. That was fatal too, and the count must stay truthful without a staging DB.
  it('still imports in-memory when the staging database cannot be opened', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    mkdirSync(dirname(targetCookiesPath), { recursive: true })
    // A live partition DB that copies fine but is not openable as SQLite.
    writeFileSync(targetCookiesPath, 'not a sqlite database')

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(cookieWriteMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'source-value' })
      )
      // The summary counts importable cookies, not staged rows.
      expect(result.ok && result.summary?.importedCookies).toBe(1)
      expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: #9355 — registering a staged path that was never written would make the next cold start
  // replay a missing or partial DB over the live partition.
  it('never registers a restart replay when staging is unavailable', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    mkdirSync(dirname(targetCookiesPath), { recursive: true })
    writeFileSync(targetCookiesPath, 'not a sqlite database')
    // Forces the restart fallback to be the only way these cookies could ever land.
    cookieWriteMock.mockRejectedValue(new Error('cookie rejected'))

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      // An older staged DB must not survive an import that already rewrote the live session.
      expect(clearPendingCookieImportMock).toHaveBeenCalledWith('persist:test')
      expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
      // Why: the jar was cleared and nothing replaced it, so this must not read as a clean success.
      expect(result.ok && result.summary?.warning).toEqual({
        code: 'restart-fallback-unavailable',
        loadedCookies: 0,
        failedCookies: 1
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: #9355 — a staging write that fails mid-transaction must disable the restart fallback
  // rather than abort an import whose in-memory half still works.
  it('still imports in-memory when a staging insert fails', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    const targetDb = createChromiumCookieTestDatabase(targetCookiesPath, [])
    // Rejects every staged row the way a corrupt index or disk error would.
    targetDb.exec(
      `CREATE TRIGGER reject_insert BEFORE INSERT ON cookies
       BEGIN SELECT RAISE(ABORT, 'staging write failed'); END`
    )
    targetDb.close()
    // Why: without a memory failure, memoryFailed === 0 would suppress registration on its own and
    // the assertion below would pass even if the insert failure never disabled staging.
    cookieWriteMock.mockRejectedValue(new Error('cookie rejected'))

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(cookieWriteMock).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'sid', value: 'source-value' })
      )
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      expect(clearPendingCookieImportMock).toHaveBeenCalledWith('persist:test')
      expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: #9355 — a successful in-memory import must retire any older staged replay, or the next
  // cold start will overwrite the live session with a stale snapshot.
  it('clears a stale staged replay after an import that fully succeeds in memory', async () => {
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
      expect(clearPendingCookieImportMock).toHaveBeenCalledWith('persist:test')
      // A fully in-memory import needs no restart, so it must not warn.
      expect(result.ok && result.summary?.warning).toBeUndefined()
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: the staged path is the restart fallback's only input, so a working staging DB must register it.
  it('registers the staged database when cookies need a restart', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    cookieWriteMock.mockRejectedValue(new Error('cookie rejected'))

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok).toBe(true)
      expect(setPendingCookieImportMock).toHaveBeenCalledTimes(1)
      const [partition, stagedPath] = setPendingCookieImportMock.mock.calls[0]
      expect(partition).toBe('persist:test')
      expect(existsSync(stagedPath as string)).toBe(true)
    } finally {
      platformSpy.mockRestore()
    }
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
