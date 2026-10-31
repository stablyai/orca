import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'
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

vi.mock('../browser-session-registry', () => ({
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
    dispose: () => undefined
  })
}))

import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCookiesFromBrowser } from './browser-cookie-import'
import type { DetectedBrowser } from './sources/browser-cookie-detection-types'

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
  // Resolve macOS /var aliases before comparing paths.
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
  // Route partitions have no startup replay consumer; do not leave plaintext staged cookies.
  it('counts rejected rows without producing staged replay', async () => {
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
    cookiesSetMock.mockRejectedValue(new Error('cookie rejected'))

    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      const result = await importCookiesFromBrowser(
        chromeBrowser(sourceCookiesPath),
        routePartition
      )

      expect(result.ok).toBe(true)
      expect(setPendingCookieImportMock).not.toHaveBeenCalled()
      expect(clearPendingCookieImportMock).toHaveBeenCalledExactlyOnceWith(routePartition)
      expect(existsSync(join(tmpDir, 'userData', 'cookie-import-staging'))).toBe(false)
      // Verify that plaintext copies were never written, rather than merely cleaned up.
      expect(
        copyFileSyncMock.mock.calls.some(([, destination]) =>
          String(destination).includes('cookie-import-staging')
        )
      ).toBe(false)
      expect(result.ok && result.summary?.warning).toBeUndefined()
      expect(result.ok && result.summary).toMatchObject({ importedCookies: 0, skippedCookies: 1 })
    } finally {
      platformSpy.mockRestore()
    }
  })
})
