import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  copyFileSyncMock,
  runProcessMock,
  sessionFromPartitionMock,
  dialogShowOpenDialogMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  runProcessMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  dialogShowOpenDialogMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn()
}))

vi.mock('../sessions/browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))

// Mock credential output at the process wrapper; it owns timeouts and console hiding.
vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
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
import { importCookiesFromBrowser } from './browser-cookie-import'
import type { DetectedBrowser } from './sources/browser-cookie-source-profiles'

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

    expect(result).toMatchObject({ ok: false, reason: 'All Safari cookies are expired.' })
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
    runProcessMock.mockReset()
    runProcessMock.mockRejectedValue(
      new Error('OS credential commands are unavailable in this test')
    )
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
      expect(runProcessMock).not.toHaveBeenCalled()
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
    runProcessMock.mockResolvedValue({
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
      expect(runProcessMock).toHaveBeenCalledWith({
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
})
