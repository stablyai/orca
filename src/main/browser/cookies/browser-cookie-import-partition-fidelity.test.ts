import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type { CookiesGetFilter } from 'electron'

const {
  appGetPathMock,
  copyFileSyncMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  writeCookieIdentityMock: vi.fn()
}))

vi.mock('../sessions/profiles/browser-session-registry', () => ({
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
  dialog: { showOpenDialog: vi.fn() },
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
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { DetectedBrowser } from './sources/browser-cookie-source-profiles'

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
    profiles: [{ name: 'default-release', directory: 'default-release' }],
    selectedProfile: 'default-release'
  }
}

// Only __init may use cookies.set; imported cookies require CDP partition identities.
const unreachableCookieSet = vi.fn(async (details: { name: string }) => {
  if (details.name !== '__init') {
    throw new Error(`cookies.set was called for user cookie ${details.name}`)
  }
})

describe('native Chromium import partition fidelity', () => {
  let tmpDir: string
  let cookieWriteMock: ReturnType<typeof vi.fn>
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-partition-fidelity-native-'))
    cookieWriteMock = writeCookieIdentityMock
    cookieWriteMock.mockReset()
    cookieWriteMock.mockResolvedValue(undefined)
    appGetPathMock.mockReset().mockReturnValue(join(tmpDir, 'userData'))
    copyFileSyncMock.mockClear()
    setPendingCookieImportMock.mockClear()
    clearPendingCookieImportMock.mockClear()
    execFileSyncMock.mockReset().mockImplementation(() => {
      throw new Error('OS credential commands are unavailable in this test')
    })
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        set: unreachableCookieSet,
        remove: vi.fn().mockResolvedValue(undefined),
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    platformSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Verify the outgoing identity here; the Electron success fixture checks Chromium’s stored cookie.

  it('never stages a partitioned row whose ancestor bit is unreadable', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    mkdirSync(dirname(sourceCookiesPath), { recursive: true })
    const legacyDb = new DatabaseSync(sourceCookiesPath)
    legacyDb.exec(`
    CREATE TABLE cookies (
      creation_utc INTEGER NOT NULL,
      host_key TEXT NOT NULL,
      top_frame_site_key TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      encrypted_value BLOB NOT NULL DEFAULT X'',
      path TEXT NOT NULL,
      expires_utc INTEGER NOT NULL,
      is_secure INTEGER NOT NULL,
      is_httponly INTEGER NOT NULL,
      samesite INTEGER NOT NULL,
      source_scheme INTEGER NOT NULL DEFAULT 0,
      source_port INTEGER NOT NULL DEFAULT -1,
      last_update_utc INTEGER NOT NULL DEFAULT 0
    )
    `)
    legacyDb.exec(`
    INSERT INTO cookies VALUES
      (133000000000000, '.app.acme-chips.test', 'https://top.example', 'chips-auth', 'keep-me', X'', '/', 0, 1, 0, 1, 0, -1, 0),
      (133000000000001, '.plain.example', '', 'plain', 'plain-ok', X'', '/', 0, 1, 0, 0, 0, -1, 0)
    `)
    legacyDb.close()
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies'),
      []
    ).close()
    cookieWriteMock.mockRejectedValueOnce(new Error('plain cookie needs restart'))

    const blocked = await importCookiesFromBrowser(
      chromeBrowser(sourceCookiesPath),
      'persist:test',
      {
        canReportPartitionSkippedCookies: false
      }
    )
    expect(blocked.ok).toBe(false)
    expect(blocked.ok || blocked.reason).toContain('cannot report')
    expect(cookieWriteMock).not.toHaveBeenCalled()
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
    const blockedSession = sessionFromPartitionMock.mock.results[0].value
    expect(blockedSession.clearData).not.toHaveBeenCalled()
    expect(blockedSession.cookies.remove).not.toHaveBeenCalled()

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(cookieWriteMock).toHaveBeenCalledTimes(1)
    expect(cookieWriteMock.mock.calls[0][0].name).toBe('plain')
    expect(result.ok && result.summary?.partitionSkippedCookies).toBe(1)
    expect(result.ok && result.summary?.importedCookies).toBe(0)
    expect(result.ok && result.summary?.skippedCookies).toBe(2)
    // New imports never produce replay, including readable siblings.
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
  })
})

describe('Firefox import partition fidelity', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-partition-fidelity-firefox-'))
    writeCookieIdentityMock.mockReset().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('leaves the target jar untouched when the client cannot report a partition skip', async () => {
    const sourceCookiesPath = join(tmpDir, 'cookies.sqlite')
    const sourceDb = new DatabaseSync(sourceCookiesPath)
    sourceDb.exec(`
      CREATE TABLE moz_cookies (
        name TEXT,
        value TEXT,
        host TEXT,
        path TEXT,
        expiry INTEGER,
        isSecure INTEGER,
        isHttpOnly INTEGER,
        sameSite INTEGER,
        originAttributes TEXT,
        isPartitionedAttributeSet INTEGER
      );
      INSERT INTO moz_cookies VALUES
        ('chips-auth', 'keep-me', '.app.example', '/', 0, 1, 1, 0,
         '^partitionKey=(https,top.example)', 1),
        ('dfpi', 'dfpi-ok', '.dfpi.example', '/', 0, 1, 0, 0,
         '^partitionKey=(https,top.example,f)', 0)
    `)
    sourceDb.close()
    const get = vi.fn().mockResolvedValue([
      {
        name: 'existing-session',
        value: 'still-valid',
        domain: '.app.example',
        path: '/',
        secure: true,
        httpOnly: true,
        hostOnly: false,
        session: true,
        sameSite: 'lax'
      }
    ])
    const remove = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReturnValue({ cookies: { get, remove } })

    const result = await importCookiesFromBrowser(
      firefoxBrowser(sourceCookiesPath),
      'persist:test',
      { canReportPartitionSkippedCookies: false }
    )

    expect(result.ok).toBe(false)
    expect(result.ok || result.reason).toContain('cannot report')
    expect(get).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(writeCookieIdentityMock).not.toHaveBeenCalled()

    get.mockResolvedValue([])
    const supportedResult = await importCookiesFromBrowser(
      firefoxBrowser(sourceCookiesPath),
      'persist:test'
    )

    expect(supportedResult.ok).toBe(true)
    expect(supportedResult.ok && supportedResult.summary?.partitionSkippedCookies).toBe(1)
    expect(supportedResult.ok && supportedResult.summary?.importedCookies).toBe(1)
    expect(writeCookieIdentityMock).toHaveBeenCalledOnce()
    expect(writeCookieIdentityMock.mock.calls[0][0].name).toBe('dfpi')
  })
})
