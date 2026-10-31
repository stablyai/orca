import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'

const {
  appGetPathMock,
  clearPendingCookieImportMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn()
}))

vi.mock('../browser-session-registry', () => ({
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
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: CookiesGetFilter) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
      set?: (details: Record<string, unknown>) => Promise<void>
    }
  }) => ({
    get: (filter: CookiesGetFilter) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    // Route CDP writes to the same spy so a missing method cannot make rejection checks pass.
    writeCookieIdentity: (identity: Record<string, unknown>) =>
      targetSession.cookies.set!(identity),
    snapshotClearIdentities: async (
      items: {
        cookie: {
          name: string
          value: string
          domain?: string
          path?: string
          secure?: boolean
          httpOnly?: boolean
          sameSite: string
          expirationDate?: number
          hostOnly?: boolean
        }
        url: string
      }[]
    ) =>
      items.map(({ cookie, url }) => ({
        url,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        hostOnly: cookie.hostOnly,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expirationDate: cookie.expirationDate
      })),
    restoreClearIdentities: async (
      identities: {
        url: string
        name: string
        value: string
        domain?: string
        path?: string
        secure?: boolean
        httpOnly?: boolean
        sameSite: string
        expirationDate?: number
        hostOnly?: boolean
      }[]
    ) => {
      if (!targetSession.cookies.set) {
        return
      }
      for (const identity of identities.toReversed()) {
        await targetSession.cookies.set({
          url: identity.url,
          name: identity.name,
          value: identity.value,
          ...(identity.hostOnly ? {} : { domain: identity.domain }),
          ...(identity.path ? { path: identity.path } : {}),
          secure: identity.secure,
          httpOnly: identity.httpOnly,
          sameSite: identity.sameSite,
          ...(identity.expirationDate ? { expirationDate: identity.expirationDate } : {})
        })
      }
    },
    dispose: () => undefined
  })
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function existingCookie(domain: string, name: string) {
  return { domain, name, path: '/', secure: true, sameSite: 'unspecified', value: 'live' }
}

const INCOMING = [
  { domain: '.google.com', name: 'SAPISID', value: 'transplanted', secure: true },
  { domain: 'accounts.google.com', name: '__Secure-1PSID', value: 'transplanted', secure: true },
  { domain: '.youtube.com', name: 'LOGIN_INFO', value: 'transplanted', secure: true },
  { domain: '.linear.app', name: 'session', value: 'new', secure: true }
]

describe('file import excludes the Google cookie family', () => {
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-google-exclusion-file-'))
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReturnValue({
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

  it('writes no Google cookie and removes none, whatever is already in the jar', async () => {
    cookiesGetMock.mockResolvedValue([
      existingCookie('.google.com', 'SID'),
      existingCookie('accounts.google.com', '__Secure-1PSID'),
      existingCookie('.linear.app', 'old-linear')
    ])

    const result = await importCookiesFromFile(writeCookies(INCOMING), 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 4,
      importedCookies: 2,
      skippedCookies: 2,
      googleCookiesSkipped: 2,
      domains: ['linear.app', 'youtube.com']
    })
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock.mock.calls.map(([details]) => details.domain)).toEqual([
      '.youtube.com',
      '.linear.app'
    ])
  })
})

describe('native Chromium import excludes the Google cookie family', () => {
  let clearDataMock: ReturnType<typeof vi.fn>
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let tmpDir: string
  let platformSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-google-exclusion-native-'))
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    execFileSyncMock.mockImplementation(() => {
      throw new Error('OS browser version lookup unavailable')
    })
    clearDataMock = vi.fn().mockResolvedValue(undefined)
    cookiesGetMock = vi.fn().mockResolvedValue([])
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        flushStore: vi.fn().mockResolvedValue(undefined),
        get: cookiesGetMock,
        remove: cookiesRemoveMock,
        set: cookiesSetMock
      },
      clearData: clearDataMock,
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  })

  afterEach(() => {
    platformSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function seedSource(rows: { domain: string; name: string; value: string }[]): string {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, rows).close()
    return sourceCookiesPath
  }

  function seedTarget(rows: { domain: string; name: string; value: string }[]): void {
    const targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(targetCookiesPath, rows).close()
  }

  it('imports eligible rows without clearing any destination cookie', async () => {
    const sourceCookiesPath = seedSource([
      { domain: '.google.com', name: 'SID', value: 'transplanted-sid' },
      { domain: '.example.com', name: 'session', value: 'new' }
    ])
    seedTarget([{ domain: '.google.com', name: 'SID', value: 'live-sid' }])
    cookiesGetMock.mockResolvedValue([
      existingCookie('.google.com', 'SID'),
      existingCookie('.example.com', 'stale')
    ])

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      googleCookiesSkipped: 1,
      domains: ['example.com']
    })
    expect(clearDataMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock).not.toHaveBeenCalled()
    expect(cookiesSetMock.mock.calls.map(([details]) => details.domain)).toEqual(['.example.com'])
  })

  it('reports an excluded Google row even when its encrypted value is invalid', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      {
        domain: '.google.com',
        name: 'SID',
        value: '',
        encryptedValue: Buffer.from('v10-invalid')
      },
      { domain: '.example.com', name: 'session', value: 'new' }
    ]).close()
    seedTarget([])

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok && result.summary).toMatchObject({
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      googleCookiesSkipped: 1
    })
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(cookiesSetMock.mock.calls.map(([details]) => details.name)).toEqual(['session'])
  })
})

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
