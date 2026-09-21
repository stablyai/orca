import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock,
  writeCookieIdentityMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
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
vi.mock('node:fs', async (importOriginal) => await importOriginal<typeof NodeFs>())
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
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importCookiesFromBrowser, type DetectedBrowser } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'

// Why (STA-4797): every other end-to-end fixture in this module starts with an empty target jar,
// which is precisely why four gates — review, readiness audit, Electron QA and CI — passed an
// import that signed the user out of every site in the partition. A jar with sessions for domains
// OUTSIDE the import set is the only fixture that can observe the defect at all.
function populatedTargetJar(): Record<string, unknown>[] {
  return [
    // The site from the Electron QA report: a working login the import never mentions.
    {
      name: 'rack.session',
      value: 'live-login',
      domain: 'the-internet.herokuapp.com',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    },
    // An unrelated site whose cookie has no derivable removal URL. Out of scope, so it must not
    // fail the import either.
    {
      name: 'orphan',
      value: 'no-domain',
      domain: '',
      hostOnly: true,
      path: '/',
      secure: false,
      httpOnly: false,
      sameSite: 'no_restriction'
    },
    // Google is exempt by policy (STA-3811) and stays exempt.
    {
      name: 'SID',
      value: 'google-live',
      domain: '.google.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction'
    },
    // In scope: the import brings github.com, so this stale cookie is what the clear is FOR.
    {
      name: 'user_session',
      value: 'stale-github',
      domain: '.github.com',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax'
    }
  ]
}

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

describe('native cookie import clear scope', () => {
  let tmpDir: string
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let sourceCookiesPath: string
  let targetCookiesPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-import-scope-'))
    sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    targetCookiesPath = join(tmpDir, 'userData', 'Partitions', 'test', 'Network', 'Cookies')
    cookiesRemoveMock = vi.fn().mockResolvedValue(undefined)
    writeCookieIdentityMock.mockReset()
    writeCookieIdentityMock.mockResolvedValue(undefined)
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    setPendingCookieImportMock.mockClear()
    clearPendingCookieImportMock.mockClear()
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => {
      throw new Error('OS credential commands are unavailable in this test')
    })
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue(populatedTargetJar()),
        set: vi.fn(async () => undefined),
        remove: cookiesRemoveMock,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('leaves sessions for sites outside the import set signed in', async () => {
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.github.com', name: 'user_session', value: 'imported-github' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    const removedNames = cookiesRemoveMock.mock.calls.map(([, name]) => name)
    expect(removedNames).toEqual(['user_session'])
    expect(cookiesRemoveMock).toHaveBeenCalledWith('https://github.com/', 'user_session')
    // The three assertions the whole ticket is about.
    expect(removedNames).not.toContain('rack.session')
    expect(removedNames).not.toContain('SID')
    expect(removedNames).not.toContain('orphan')
  })

  it('clears a subdomain of an imported domain, and nothing under a sibling registrable domain', async () => {
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi.fn().mockResolvedValue([
          {
            name: 'gist-session',
            value: 'stale',
            domain: 'gist.github.com',
            hostOnly: true,
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'lax'
          },
          {
            name: 'lookalike',
            value: 'live',
            domain: 'notgithub.com',
            hostOnly: true,
            path: '/',
            secure: true,
            httpOnly: true,
            sameSite: 'lax'
          }
        ]),
        set: vi.fn(async () => undefined),
        remove: cookiesRemoveMock,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.github.com', name: 'user_session', value: 'imported-github' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(cookiesRemoveMock.mock.calls.map(([, name]) => name)).toEqual(['gist-session'])
  })

  // Why: cold-start replay uses the staged image after the live import has returned. An in-memory
  // assertion cannot prove its rows and recorded merge scope preserve unrelated sessions.
  it('keeps out-of-scope rows in the staged cold-start image', async () => {
    // Why: no unaddressable cookie in this jar — the staged image is what this case is about, so
    // the live clear must run to completion rather than aborting on something else.
    sessionFromPartitionMock.mockReturnValue({
      cookies: {
        get: vi
          .fn()
          .mockResolvedValue(populatedTargetJar().filter((cookie) => cookie.domain !== '')),
        set: vi.fn(async () => undefined),
        remove: cookiesRemoveMock,
        flushStore: vi.fn().mockResolvedValue(undefined)
      },
      clearData: vi.fn().mockResolvedValue(undefined),
      setUserAgent: vi.fn(),
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'test')
    })
    writeCookieIdentityMock.mockRejectedValue(new Error('rejected so the staged image is kept'))
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { domain: '.github.com', name: 'user_session', value: 'imported-github' }
    ]).close()
    createChromiumCookieTestDatabase(
      targetCookiesPath,
      [
        { domain: 'the-internet.herokuapp.com', name: 'rack.session', value: 'live-login' },
        { domain: '.google.com', name: 'SID', value: 'google-live' },
        { domain: '.github.com', name: 'user_session', value: 'stale-github' }
      ],
      { journalMode: 'wal' }
    ).close()

    const result = await importCookiesFromBrowser(chromeBrowser(sourceCookiesPath), 'persist:test')

    expect(result.ok).toBe(true)
    expect(setPendingCookieImportMock).toHaveBeenCalledTimes(1)
    const stagedPath = setPendingCookieImportMock.mock.calls[0][1] as string
    expect(existsSync(`${stagedPath}-wal`)).toBe(false)
    const staged = new DatabaseSync(stagedPath, { readOnly: true })
    try {
      expect(
        staged.prepare('SELECT domain, format_version FROM orca_cookie_import_scope').all()
      ).toEqual([{ domain: 'github.com', format_version: 1 }])
      const rows = (
        staged
          .prepare('SELECT host_key, name, value FROM cookies ORDER BY host_key, name')
          .all() as { host_key: string; name: string; value: string | Uint8Array }[]
      ).map((row) => ({
        ...row,
        // Why: a staged row copies the source value column verbatim, which node:sqlite hands back
        // as bytes when it was written from a buffer.
        value: typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('latin1')
      }))
      expect(rows).toEqual([
        // The stale github.com row was replaced by the imported one — the clear that is justified.
        { host_key: '.github.com', name: 'user_session', value: 'imported-github' },
        { host_key: '.google.com', name: 'SID', value: 'google-live' },
        // Still signed in, one restart later.
        { host_key: 'the-internet.herokuapp.com', name: 'rack.session', value: 'live-login' }
      ])
    } finally {
      staged.close()
    }
  })
})
