import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

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
  dialog: { showOpenDialog: vi.fn() },
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
    // method would throw a TypeError the per-cookie catch swallows, quietly routing every write
    // down the rejected-cookie path while the suite still looked green.
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import type { DetectedBrowser } from './browser-cookie-import'

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

// Why (STA-4300): cookies.set() silently drops partitionKey, so no user cookie may reach it. Only
// the __init probe — which writes no user data — is allowed through; anything else is the
// downgrade returning, and it must fail the test rather than quietly succeed.
const unreachableCookieSet = vi.fn(async (details: { name: string }) => {
  if (details.name !== '__init') {
    throw new Error(`cookies.set was called for user cookie ${details.name}`)
  }
})

describe('validated import partition fidelity', () => {
  let tmpDir: string
  let cookieWriteMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-partition-fidelity-file-'))
    cookieWriteMock = writeCookieIdentityMock
    cookieWriteMock.mockReset()
    cookieWriteMock.mockResolvedValue(undefined)
    setPendingCookieImportMock.mockClear()
    clearPendingCookieImportMock.mockClear()
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
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

  // Why (STA-4300): a JSON export that carries a full CHIPS partition must reach the jar with it.
  // cookies.set() drops partitionKey silently, so this only works through the CDP identity store.
  it('carries a complete partitionKey from a JSON export through to the write', async () => {
    const filePath = writeCookieFile([
      {
        domain: '.app.example',
        name: 'chips-auth',
        value: 'keep-me',
        secure: true,
        sameSite: 'None',
        partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
      }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(true)
    expect(cookieWriteMock).toHaveBeenCalledTimes(1)
    expect(cookieWriteMock.mock.calls[0][0]).toMatchObject({
      name: 'chips-auth',
      partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
    })
    expect(result.ok && result.summary.partitionSkippedCookies).toBeUndefined()
  })

  // Why (STA-4300): exporters that emit only topLevelSite carry no ancestor bit. Writing the cookie
  // unpartitioned would report a clean success the site cannot use, so it is skipped and counted.
  it('skips and reports a cookie whose partitionKey cannot be read faithfully', async () => {
    const filePath = writeCookieFile([
      {
        domain: '.app.example',
        name: 'chips-auth',
        value: 'keep-me',
        secure: true,
        partitionKey: { topLevelSite: 'https://top.example' }
      },
      { domain: '.plain.example', name: 'plain', value: 'ok' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(true)
    // The lossy write is not merely unused — only the readable cookie was ever attempted.
    expect(cookieWriteMock).toHaveBeenCalledTimes(1)
    expect(cookieWriteMock.mock.calls[0][0].name).toBe('plain')
    expect(result.ok && result.summary.partitionSkippedCookies).toBe(1)
    expect(result.ok && result.summary.importedCookies).toBe(1)
    expect(result.ok && result.summary.skippedCookies).toBe(1)
    expect(result.ok && result.summary.domains).toEqual(['plain.example'])
  })

  it('does not replace existing cookies for a domain whose only source cookie is skipped', async () => {
    const remove = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue([
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
        ]),
        remove,
        set: unreachableCookieSet
      }
    })
    const filePath = writeCookieFile([
      {
        domain: '.app.example',
        name: 'chips-auth',
        value: 'keep-me',
        secure: true,
        partitionKey: { topLevelSite: 'https://top.example' }
      }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary.partitionSkippedCookies).toBe(1)
    expect(cookieWriteMock).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })

  it('preserves a populated family and creates no staged replay for an opaque JSON partition', async () => {
    const targetJar = [
      {
        name: 'live-session',
        value: 'must-survive',
        domain: '.preserved.example',
        path: '/',
        secure: true,
        sameSite: 'lax'
      }
    ]
    const remove = vi.fn(async (_url: string, name: string) => {
      const index = targetJar.findIndex((cookie) => cookie.name === name)
      if (index !== -1) {
        targetJar.splice(index, 1)
      }
    })
    sessionFromPartitionMock.mockReturnValue({
      cookies: { get: vi.fn(async () => targetJar), remove, set: unreachableCookieSet }
    })
    const filePath = writeCookieFile([
      {
        domain: '.preserved.example',
        name: 'opaque-session',
        value: 'do-not-downgrade',
        secure: true,
        partitionKeyOpaque: true
      },
      { domain: 'sub.preserved.example', name: 'sibling', value: 'do-not-write', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      importedCookies: 0,
      skippedCookies: 2,
      partitionSkippedCookies: 2
    })
    expect(targetJar).toEqual([expect.objectContaining({ name: 'live-session' })])
    expect(remove).not.toHaveBeenCalled()
    expect(cookieWriteMock).not.toHaveBeenCalled()
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
  })

  it.each([
    ['null', null],
    ['empty string', '']
  ])('preserves a populated family for a present %s partitionKey', async (_label, partitionKey) => {
    const targetJar = [
      {
        name: 'apex-session',
        value: 'apex-live',
        domain: '.preserved.example',
        path: '/',
        secure: true,
        sameSite: 'lax'
      },
      {
        name: 'sub-session',
        value: 'sub-live',
        domain: 'sub.preserved.example',
        path: '/',
        secure: true,
        sameSite: 'lax'
      },
      {
        name: 'stale-plain',
        value: 'replace-me',
        domain: '.plain.example',
        path: '/',
        secure: true,
        sameSite: 'lax'
      }
    ]
    const remove = vi.fn(async (_url: string, name: string) => {
      const index = targetJar.findIndex((cookie) => cookie.name === name)
      if (index !== -1) {
        targetJar.splice(index, 1)
      }
    })
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn(async () => targetJar),
        remove,
        set: unreachableCookieSet
      }
    })
    const filePath = writeCookieFile([
      {
        domain: '.preserved.example',
        name: 'malformed-partition',
        value: 'do-not-write',
        secure: true,
        partitionKey
      },
      {
        domain: 'deep.sub.preserved.example',
        name: 'readable-sibling',
        value: 'do-not-write-either',
        secure: true
      },
      { domain: '.plain.example', name: 'plain', value: 'write-me', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(targetJar).toEqual([
      expect.objectContaining({ name: 'apex-session', value: 'apex-live' }),
      expect.objectContaining({ name: 'sub-session', value: 'sub-live' })
    ])
    expect(remove.mock.calls.map(([, name]) => name)).toEqual(['stale-plain'])
    expect(cookieWriteMock).toHaveBeenCalledTimes(1)
    expect(cookieWriteMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'plain' }))
    expect(cookieWriteMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'readable-sibling' })
    )
    expect(result.summary).toMatchObject({
      totalCookies: 3,
      importedCookies: 1,
      skippedCookies: 2,
      partitionSkippedCookies: 2,
      domains: ['plain.example']
    })
    expect(result.summary.totalCookies).toBe(
      result.summary.importedCookies + result.summary.skippedCookies
    )
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
  })
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

  // Why (STA-4300): the native path's in-memory load used cookies.set(), which drops partitionKey
  // silently. This pins the identity that actually reaches the jar; the end-to-end proof that
  // Chromium stores it is browser-cookie-import-partition-success.electron.test.ts.
  it('carries a partitioned source row through to the write with both partition halves', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.app.acme-chips.test',
        name: 'chips-auth',
        value: 'keep-me',
        isSecure: 1,
        sameSite: 1,
        topFrameSiteKey: 'https://top.example',
        hasCrossSiteAncestor: 1
      },
      { domain: '.plain.example', name: 'plain', value: 'plain-ok', isSecure: 1 }
    ]).close()
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies'),
      []
    ).close()

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(cookieWriteMock).toHaveBeenCalledTimes(2)
    const written = cookieWriteMock.mock.calls.map((call) => call[0])
    expect(written.find((cookie) => cookie.name === 'chips-auth')).toMatchObject({
      partitionKey: { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
    })
    expect(written.find((cookie) => cookie.name === 'plain')).not.toHaveProperty('partitionKey')
    expect(result.ok && result.summary?.partitionSkippedCookies).toBeUndefined()
  })

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
    // Only the readable cookie was ever attempted — the unreadable one reached no writer at all.
    expect(cookieWriteMock).toHaveBeenCalledTimes(1)
    expect(cookieWriteMock.mock.calls[0][0].name).toBe('plain')
    expect(result.ok && result.summary?.partitionSkippedCookies).toBe(1)
    expect(result.ok && result.summary?.importedCookies).toBe(1)
    expect(result.ok && result.summary?.skippedCookies).toBe(1)
    // Why (STA-4300 §4.3b): this assertion is STRONGER than the one it replaces. bf6dc6fcba staged
    // an image and merely omitted the unreadable row from it; that image is a whole-database
    // replacement on the next start, so it would still have erased the preserved family it was
    // supposed to leave alone. A skip-bearing import now registers NO image at all, which closes
    // the cold-start channel by construction rather than by a staged predicate that has to be right.
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
  })

  it('preserves a populated family when the partition site is malformed', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.preserved.example',
        name: 'invalid-partition',
        value: 'source-value',
        topFrameSiteKey: 'https://top.example/not-a-site',
        hasCrossSiteAncestor: 1
      },
      { domain: '.plain.example', name: 'plain', value: 'plain-ok' }
    ]).close()
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies'),
      []
    ).close()
    const targetJar = [
      {
        name: 'live-session',
        value: 'must-survive',
        domain: '.preserved.example',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax'
      }
    ]
    const clearData = vi.fn(async () => targetJar.splice(0))
    const remove = vi.fn(async (_url: string, name: string) => {
      const index = targetJar.findIndex((cookie) => cookie.name === name)
      if (index !== -1) {
        targetJar.splice(index, 1)
      }
    })
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn(async () => targetJar),
        set: unreachableCookieSet,
        remove,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData,
      setUserAgent: vi.fn(),
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(clearData).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalledWith(expect.any(String), 'live-session')
    expect(targetJar).toEqual([expect.objectContaining({ name: 'live-session' })])
    expect(cookieWriteMock).toHaveBeenCalledTimes(1)
    expect(cookieWriteMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'plain' }))
    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      partitionSkippedCookies: 1
    })
    expect(setPendingCookieImportMock).not.toHaveBeenCalled()
  })

  // Why: without this, "disable staging on a skip" could be implemented as "disable staging
  // always" and no test would notice — a real regression to the restart path wearing the disguise
  // of a safety fix.
  it('still stages a cold-restart image when nothing is preserved', async () => {
    const sourceCookiesPath = join(tmpDir, 'Cookies')
    const legacyDb = new DatabaseSync(sourceCookiesPath)
    legacyDb.exec(`
      CREATE TABLE cookies (
        creation_utc INTEGER NOT NULL,
        host_key TEXT NOT NULL,
        top_frame_site_key TEXT NOT NULL,
        name TEXT NOT NULL,
        value TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        last_access_utc INTEGER NOT NULL,
        has_expires INTEGER NOT NULL,
        is_persistent INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        samesite INTEGER NOT NULL,
        source_scheme INTEGER NOT NULL,
        has_cross_site_ancestor INTEGER NOT NULL
      );
      INSERT INTO cookies VALUES
        (133000000000000, '.plain.example', '', 'plain', 'plain-ok', X'', '/', 0, 1, 0, 0, 0, -1, 0, 0, 2, 0)
    `)
    legacyDb.close()
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies'),
      []
    ).close()
    cookieWriteMock.mockRejectedValueOnce(new Error('plain cookie needs restart'))

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(result.ok && result.summary?.partitionSkippedCookies).toBeUndefined()
    expect(setPendingCookieImportMock).toHaveBeenCalledOnce()
    const stagedPath = setPendingCookieImportMock.mock.calls[0][1] as string
    const stagedDb = new DatabaseSync(stagedPath, { readOnly: true })
    const stagedNames = stagedDb.prepare('SELECT name FROM cookies ORDER BY name').all()
    stagedDb.close()
    expect(stagedNames).toEqual([{ name: 'plain' }])
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
