import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const {
  appGetPathMock,
  copyFileSyncMock,
  execFileSyncMock,
  sessionFromPartitionMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  copyFileSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn()
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
    dispose: () => undefined
  })
}))

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCookiesFromBrowser, type DetectedBrowser } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'

const routePartition = `persist:orca-browser-v1-${'b'.repeat(64)}`
let tmpDir = ''
let cookiesSetMock: ReturnType<typeof vi.fn>

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

beforeEach(() => {
  // Why: macOS reports /private/var for a /var mkdtemp path, so resolve before comparing paths.
  tmpDir = realpathSync(mkdtempSync(join(tmpdir(), 'orca-route-cookie-staging-')))
  cookiesSetMock = vi.fn().mockResolvedValue(undefined)
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
      set: cookiesSetMock,
      remove: vi.fn().mockResolvedValue(undefined),
      flushStore: vi.fn().mockResolvedValue(undefined)
    },
    clearData: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn(),
    getStoragePath: () =>
      join(tmpDir, 'userData', 'Partitions', routePartition.replace('persist:', ''))
  })
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('importCookiesFromBrowser into a client-hosted route partition', () => {
  // Why: the cold-start replay only knows the default partition and persisted session profiles, so
  // a route partition can never be replayed — staging one would leave a plaintext cookie DB in
  // userData forever and still report a lossy import as a clean success.
  it('refuses the restart fallback instead of staging a plaintext cookie database', async () => {
    const sourceCookiesPath = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    const targetCookiesPath = join(
      tmpDir,
      'userData',
      'Partitions',
      routePartition.replace('persist:', ''),
      'Network',
      'Cookies'
    )
    createChromiumCookieTestDatabase(sourceCookiesPath, [
      { name: 'sid', value: 'source-value' }
    ]).close()
    createChromiumCookieTestDatabase(targetCookiesPath, []).close()
    // Forces the restart fallback to be the only way these cookies could ever land.
    cookiesSetMock.mockRejectedValue(new Error('cookie rejected'))

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        routePartition
      )

      expect(result.ok).toBe(true)
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      expect(clearPendingCookieImportMock).toHaveBeenCalledWith(routePartition)
      expect(existsSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toBe(false)
      // Why: the plaintext copy must never be written, not merely deleted afterwards.
      expect(
        copyFileSyncMock.mock.calls.some(([, destination]) =>
          String(destination).includes('cookie-import-staging')
        )
      ).toBe(false)
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
})
