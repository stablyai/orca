import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  clearPendingCookieImportMock,
  disposeClearStoreMock,
  execFileSyncMock,
  restoreClearIdentitiesMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock,
  snapshotClearIdentitiesMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  disposeClearStoreMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  restoreClearIdentitiesMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  snapshotClearIdentitiesMock: vi.fn()
}))

vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
vi.mock('node:child_process', () => ({ execFileSync: execFileSyncMock }))
vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: sessionFromPartitionMock }
}))
// Why: snapshot/restore are spies, not no-ops, so a rollback that never ran cannot pass as one.
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: object) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
      set?: (details: Record<string, unknown>) => Promise<void>
    }
  }) => ({
    get: (filter: object) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    // Why (STA-4300): the import writes go through CDP identities; route them to the same spy so
    // a missing method cannot silently reroute every write down the rejected-cookie path.
    writeCookieIdentity: (identity: Record<string, unknown>) =>
      targetSession.cookies.set!(identity),
    snapshotClearIdentities: snapshotClearIdentitiesMock,
    restoreClearIdentities: restoreClearIdentitiesMock,
    dispose: disposeClearStoreMock
  })
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

beforeEach(() => {
  snapshotClearIdentitiesMock
    .mockReset()
    .mockImplementation(async (items: { cookie: Record<string, unknown>; url: string }[]) =>
      items.map(({ cookie: entry, url }) => ({ url, ...entry }))
    )
  restoreClearIdentitiesMock.mockReset().mockResolvedValue(undefined)
  disposeClearStoreMock.mockReset()
})

describe('validated cookie replacement', () => {
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-replacement-test-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: { get: cookiesGetMock, remove: cookiesRemoveMock, set: cookiesSetMock }
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCookies(cookies: unknown[]): string {
    const filePath = join(tmpDir, 'cookies.json')
    writeFileSync(filePath, JSON.stringify(cookies))
    return filePath
  }

  it('keeps Google out of the replace scope so its cookies are never removed', async () => {
    cookiesGetMock.mockResolvedValue([
      cookie('.google.com', 'old-google'),
      cookie('.accounts.google.com', 'old-accounts', '/signin'),
      cookie('.example.com', 'old-example'),
      cookie('.unrelated.com', 'keep'),
      cookie('.google.com.evil.example', 'keep-suffix-confusion')
    ])
    const filePath = writeCookies([
      { domain: '.google.com', name: 'SIDCC', value: 'source-bound', secure: true },
      { domain: '.google.com', name: 'SAPISID', value: 'google-session', secure: true },
      { domain: '.example.com', name: 'SIDCC', value: 'not-google', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 3,
      importedCookies: 1,
      skippedCookies: 2,
      googleCookiesSkipped: 2,
      domains: ['example.com']
    })
    expect(cookiesRemoveMock.mock.calls).toEqual([['https://example.com/', 'old-example']])
    expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['SIDCC'])
    expect(Math.max(...cookiesRemoveMock.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...cookiesSetMock.mock.invocationCallOrder)
    )
  })

  it('does not touch the store when every valid entry is source-bound', async () => {
    const filePath = writeCookies([
      { domain: '.google.com', name: 'AEC', value: 'source-bound', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok && result.summary).toEqual({
      totalCookies: 1,
      importedCookies: 0,
      skippedCookies: 1,
      googleCookiesSkipped: 1,
      domains: []
    })
    expect(cookiesGetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  it('rejects URL-shaped domains before replacement can clear their normalized scope', async () => {
    const filePath = writeCookies([
      { domain: 'example.com/path', name: 'session', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result).toEqual({
      ok: false,
      reason: 'No valid cookies found. 1 entries were skipped due to missing or invalid fields.'
    })
    expect(cookiesGetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })

  // Why (STA-4097): this rollback puts back the user's ORIGINAL cookies, which the import had
  // already deleted. cookies.get drops partitionKey and cookies.set ignores it, so rebuilding
  // them through the Electron API resurrected CHIPS cookies unpartitioned. The undo now travels
  // back through the CDP identities, which are the only thing that carries the partition.
  it('restores the previous cookies through CDP identities when an incoming cookie is rejected', async () => {
    const partitionKey = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
    cookiesGetMock.mockResolvedValue([cookie('.example.com', 'existing')])
    snapshotClearIdentitiesMock.mockImplementation(
      async (items: { cookie: Record<string, unknown>; url: string }[]) =>
        items.map(({ cookie: entry, url }) => ({ url, ...entry, partitionKey }))
    )
    cookiesSetMock
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cookie rejected'))
    const filePath = writeCookies([
      { domain: '.example.com', name: 'first', value: 'new', secure: true },
      { domain: '.example.com', name: 'second', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(false)
    expect(cookiesRemoveMock.mock.calls).toEqual([
      ['https://example.com/', 'existing'],
      ['https://example.com/', 'second'],
      ['https://example.com/', 'first']
    ])
    expect(restoreClearIdentitiesMock).toHaveBeenCalledOnce()
    expect(restoreClearIdentitiesMock.mock.calls[0]?.[0]).toEqual([
      { url: 'https://example.com/', ...cookie('.example.com', 'existing'), partitionKey }
    ])
    // Why: cookies.set is only ever the two imported cookies — a third call would mean the
    // partition-dropping reconstruction came back.
    expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['first', 'second'])
    expect(disposeClearStoreMock).toHaveBeenCalledOnce()
  })

  // Why: restoreClearIdentities attaches a debugger before it iterates, so calling it with an
  // empty restore set would create a hidden BrowserWindow to put nothing back.
  it('does not reach for CDP when the rollback has nothing to restore', async () => {
    cookiesGetMock.mockResolvedValue([])
    cookiesSetMock
      .mockResolvedValue(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cookie rejected'))
    const filePath = writeCookies([
      { domain: '.example.com', name: 'first', value: 'new', secure: true },
      { domain: '.example.com', name: 'second', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(false)
    // Why: a rejected CDP command does not prove the cookie was not written before the transport
    // failed, so rollback must remove the failing coordinate as well as earlier successes.
    expect(cookiesRemoveMock.mock.calls).toEqual([
      ['https://example.com/', 'second'],
      ['https://example.com/', 'first']
    ])
    expect(restoreClearIdentitiesMock).not.toHaveBeenCalled()
  })

  it('fails closed when existing cookies cannot be replaced', async () => {
    cookiesGetMock.mockRejectedValue(new Error('cookie store unavailable'))
    const filePath = writeCookies([
      { domain: '.example.com', name: 'session', value: 'new', secure: true }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')

    expect(result.ok).toBe(false)
    expect(cookiesSetMock).not.toHaveBeenCalled()
  })
})

describe('native Chromium integrity-cookie accounting', () => {
  let clearDataMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-accounting-test-'))
    appGetPathMock.mockReset().mockReturnValue(join(tmpDir, 'userData'))
    execFileSyncMock.mockReset().mockImplementation(() => {
      throw new Error('OS browser version lookup unavailable')
    })
    clearPendingCookieImportMock.mockClear()
    setPendingCookieImportMock.mockClear()
    clearDataMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReset().mockReturnValue({
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
        set: cookiesSetMock
      },
      clearData: clearDataMock,
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('counts every excluded Google cookie in skippedCookies', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.google.com', name: 'AEC', value: 'source-bound' },
      { domain: '.google.com', name: 'SAPISID', value: 'google-session' },
      { domain: '.example.com', name: 'AEC', value: 'not-google' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )
      expect(result.ok && result.summary).toMatchObject({
        totalCookies: 3,
        importedCookies: 1,
        skippedCookies: 2,
        googleCookiesSkipped: 2,
        domains: ['example.com']
      })
      expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['AEC'])
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('preserves the destination when every source cookie is filtered or invalid', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.google.com', name: 'AEC', value: 'source-bound' },
      { domain: '.accounts.google.com', name: 'SIDCC', value: 'source-bound' },
      { domain: 'example.com/path', name: 'invalid-domain', value: 'invalid' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, [
      { domain: '.example.com', name: 'existing', value: 'keep' }
    ]).close()
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        'persist:test'
      )

      expect(result.ok && result.summary).toEqual({
        totalCookies: 3,
        importedCookies: 0,
        skippedCookies: 3,
        googleCookiesSkipped: 2,
        domains: []
      })
      expect(clearDataMock).not.toHaveBeenCalled()
      expect(cookiesSetMock).not.toHaveBeenCalled()
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      expect(clearPendingCookieImportMock).not.toHaveBeenCalled()
      expect(readdirSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toEqual([])
    } finally {
      platformSpy.mockRestore()
    }
  })
})

function cookie(domain: string, name: string, path = '/') {
  return { domain, name, path, secure: true, sameSite: 'unspecified', value: 'old' }
}

function chromeBrowser(cookiesPath: string) {
  return {
    family: 'chrome' as const,
    label: 'Google Chrome',
    cookiesPath,
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    profiles: [{ name: 'Default', directory: 'Default' }],
    selectedProfile: 'Default'
  }
}
