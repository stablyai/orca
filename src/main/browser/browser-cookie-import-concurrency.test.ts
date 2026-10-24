import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CookiesGetFilter } from 'electron'

const {
  appGetPathMock,
  sessionFromPartitionMock,
  snapshotClearIdentitiesMock,
  writeCookieIdentityMock,
  copyFileWithWindowsRetryMock,
  setPendingCookieImportMock,
  clearPendingCookieImportMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  sessionFromPartitionMock: vi.fn(),
  snapshotClearIdentitiesMock: vi.fn(),
  writeCookieIdentityMock: vi.fn(),
  copyFileWithWindowsRetryMock: vi.fn(),
  setPendingCookieImportMock: vi.fn(),
  clearPendingCookieImportMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  dialog: { showOpenDialog: vi.fn() },
  session: { fromPartition: sessionFromPartitionMock }
}))
// Implement CDP writes so swallowed missing-method errors cannot make ordering assertions pass.
vi.mock('./browser-cookie-clear-store', () => ({
  openCookieClearStore: (targetSession: {
    cookies: {
      get: (filter: CookiesGetFilter) => Promise<unknown>
      remove: (url: string, name: string) => Promise<void>
    }
  }) => ({
    get: (filter: CookiesGetFilter) => targetSession.cookies.get(filter),
    remove: (url: string, name: string) => targetSession.cookies.remove(url, name),
    snapshotClearIdentities: snapshotClearIdentitiesMock,
    restoreClearIdentities: async () => undefined,
    writeCookieIdentity: writeCookieIdentityMock,
    dispose: () => undefined
  })
}))
vi.mock('./browser-session-registry', () => ({
  browserSessionRegistry: {
    setPendingCookieImport: setPendingCookieImportMock,
    clearPendingCookieImport: clearPendingCookieImportMock
  }
}))
vi.mock('../codex-accounts/fs-utils', () => ({
  copyFileWithWindowsRetry: copyFileWithWindowsRetryMock
}))
vi.mock('../../shared/windows-retry-file-operations', () => ({
  copyFileWithWindowsRetry: copyFileWithWindowsRetryMock
}))

import { importCookiesFromBrowser, importCookiesFromFile } from './browser-cookie-import'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { acquireCookieMutationLock, withCookieMutationLock } from './browser-cookie-import-clear'

describe('cookie mutation lock', () => {
  it('serialises two transactions on the same owner', async () => {
    const owner = {}
    const order: string[] = []

    const first = withCookieMutationLock(owner, async () => {
      order.push('A:clear')
      await Promise.resolve()
      order.push('A:write')
    })
    const second = withCookieMutationLock(owner, async () => {
      order.push('B:clear')
      await Promise.resolve()
      order.push('B:write')
    })

    await Promise.all([first, second])

    expect(order).toEqual(['A:clear', 'A:write', 'B:clear', 'B:write'])
  })

  it('does not serialise across different owners', async () => {
    const order: string[] = []
    const a = withCookieMutationLock({}, async () => {
      order.push('a:start')
      await Promise.resolve()
      order.push('a:end')
    })
    const b = withCookieMutationLock({}, async () => {
      order.push('b:start')
      await Promise.resolve()
      order.push('b:end')
    })

    await Promise.all([a, b])

    expect(order).toContain('a:end')
    expect(order).toContain('b:end')
    expect(order).not.toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  it('releases the lock when the transaction throws, so the next import is not wedged', async () => {
    const owner = {}

    await expect(
      withCookieMutationLock(owner, async () => {
        throw new Error('clear rejected')
      })
    ).rejects.toThrow('clear rejected')

    await expect(withCookieMutationLock(owner, async () => 'second ran')).resolves.toBe(
      'second ran'
    )
  })

  it('holds across an explicit acquire/release so a rollback stays inside the transaction', async () => {
    const owner = {}
    const order: string[] = []

    const release = await acquireCookieMutationLock(owner)
    const queued = withCookieMutationLock(owner, async () => {
      order.push('B:clear')
    })

    order.push('A:replace')
    await Promise.resolve()
    order.push('A:rollback')
    release()

    await queued

    expect(order).toEqual(['A:replace', 'A:rollback', 'B:clear'])
  })

  it('leaves the lock usable if a holder releases twice', async () => {
    const owner = {}
    const release = await acquireCookieMutationLock(owner)
    release()
    release()

    await expect(withCookieMutationLock(owner, async () => 'ok')).resolves.toBe('ok')
  })
})

describe('two concurrent imports into one partition', () => {
  let tmpDir: string
  let events: string[]
  let cookiesGetMock: ReturnType<typeof vi.fn>
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let releaseFirstWrite: () => void

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-concurrency-'))
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    events = []
    copyFileWithWindowsRetryMock
      .mockReset()
      .mockImplementation((source: string, destination: string) => {
        copyFileSync(source, destination)
      })
    // A complete snapshot lets each import reach the write whose ordering this test checks.
    snapshotClearIdentitiesMock
      .mockReset()
      .mockImplementation(async (items: { cookie: Record<string, unknown>; url: string }[]) =>
        items.map(({ cookie: entry, url }) => ({ url, ...entry }))
      )

    cookiesGetMock = vi.fn().mockResolvedValue([
      { domain: '.a.example', name: 'old-a', value: 'v', path: '/', secure: true },
      { domain: '.b.example', name: 'old-b', value: 'v', path: '/', secure: true }
    ])
    cookiesRemoveMock = vi.fn(async (_url: string, name: string) => {
      events.push(`remove:${name}`)
    })
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    writeCookieIdentityMock.mockReset().mockImplementation(async (identity: { name: string }) => {
      events.push(`set:${identity.name}`)
      // Hold the first write so the second import has an opportunity to interleave.
      if (identity.name === 'new-a') {
        await firstWrite
      }
    })
    // Direct cookies.set would drop partition keys.
    cookiesSetMock = vi.fn()

    // Return the same Session for each partition, matching Electron’s lock identity.
    const stableSession = {
      cookies: { get: cookiesGetMock, remove: cookiesRemoveMock, set: cookiesSetMock }
    }
    sessionFromPartitionMock.mockReset().mockReturnValue(stableSession)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeSource(name: string, domain: string): string {
    const filePath = join(tmpDir, `${name}.json`)
    writeFileSync(
      filePath,
      JSON.stringify([{ domain, name, value: 'imported', path: '/', secure: true }])
    )
    return filePath
  }

  it('does not let the second import touch the jar until the first has finished writing', async () => {
    const fileA = writeSource('new-a', '.a.example')
    const fileB = writeSource('new-b', '.b.example')

    const first = importCookiesFromFile(fileA, 'persist:concurrency-test')
    await vi.waitFor(() => expect(events).toContain('set:new-a'))
    const second = importCookiesFromFile(fileB, 'persist:concurrency-test')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).not.toContain('remove:old-b')
    expect(events).not.toContain('set:new-b')

    releaseFirstWrite()
    const [resultA, resultB] = await Promise.all([first, second])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    // Assert both imports reached CDP writes; swallowed errors could otherwise preserve ordering.
    expect(writeCookieIdentityMock).toHaveBeenCalledTimes(2)
    expect(cookiesSetMock).not.toHaveBeenCalled()

    expect(events).toContain('set:new-a')
    expect(events).toContain('remove:old-b')
    expect(events.indexOf('set:new-a')).toBeLessThan(events.indexOf('remove:old-b'))
  })
})

describe('two concurrent NATIVE imports into one partition', () => {
  let tmpDir: string
  let events: string[]
  let cookiesRemoveMock: ReturnType<typeof vi.fn>
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let clearDataMock: ReturnType<typeof vi.fn>
  let releaseFirstWrite: () => void
  let platformSpy: { mockRestore: () => void }
  let stagingCopyCount: number

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

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-native-concurrency-'))
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    events = []
    stagingCopyCount = 0
    copyFileWithWindowsRetryMock
      .mockReset()
      .mockImplementation((source: string, destination: string) => {
        if (destination.includes('cookie-import-staging')) {
          stagingCopyCount += 1
          events.push(`copy:${stagingCopyCount === 1 ? 'first' : 'second'}`)
        }
        copyFileSync(source, destination)
      })
    // Seed in-scope cookies so the second import’s clear would expose a missing lock.
    snapshotClearIdentitiesMock
      .mockReset()
      .mockImplementation(async (items: { cookie: Record<string, unknown>; url: string }[]) =>
        items.map(({ cookie: entry, url }) => ({ url, ...entry }))
      )
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')

    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    writeCookieIdentityMock.mockReset().mockImplementation(async (identity: { name: string }) => {
      events.push(`set:${identity.name}`)
      if (identity.name === 'first') {
        await firstWrite
      }
    })
    cookiesSetMock = vi.fn()
    cookiesRemoveMock = vi.fn(async (_url: string, name: string) => {
      events.push(`remove:${name}`)
    })
    clearDataMock = vi.fn(async () => {
      events.push('clearData')
    })
    const stableSession = {
      cookies: {
        get: vi.fn().mockResolvedValue([
          { domain: '.a.example', name: 'old-a', value: 'v', path: '/', secure: true },
          { domain: '.b.example', name: 'old-b', value: 'v', path: '/', secure: true }
        ]),
        remove: cookiesRemoveMock,
        set: cookiesSetMock,
        flushStore: vi.fn(async () => {
          events.push('flushStore')
        })
      },
      clearData: clearDataMock,
      getStoragePath: () => join(tmpDir, 'userData', 'Partitions', 'native-conc'),
      setUserAgent: vi.fn()
    }
    sessionFromPartitionMock.mockReset().mockReturnValue(stableSession)
  })

  afterEach(() => {
    platformSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('does not let a second native import clear while the first is still writing', async () => {
    const sourceA = join(tmpDir, 'ChromeA', 'Default', 'Network', 'Cookies')
    const sourceB = join(tmpDir, 'ChromeB', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(sourceA, [
      { domain: '.a.example', name: 'first', value: 'v' }
    ]).close()
    createChromiumCookieTestDatabase(sourceB, [
      { domain: '.b.example', name: 'second', value: 'v' }
    ]).close()
    // Precreate the database to keep initialization probes out of this ordering test.
    createChromiumCookieTestDatabase(
      join(tmpDir, 'userData', 'Partitions', 'native-conc', 'Network', 'Cookies'),
      []
    ).close()

    // Start both imports early enough to cover staging as well as live writes.
    const first = importCookiesFromBrowser(chromeBrowser(sourceA), 'persist:native-conc')
    const second = importCookiesFromBrowser(chromeBrowser(sourceB), 'persist:native-conc')
    for (let i = 0; i < 100 && !events.includes('set:first'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    expect(events).toContain('set:first')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(events).not.toContain('copy:second')
    expect(events).toContain('remove:old-a')
    expect(events).not.toContain('remove:old-b')
    expect(events.filter((e) => e === 'flushStore')).toHaveLength(1)
    expect(events).not.toContain('set:second')
    expect(clearDataMock).not.toHaveBeenCalled()

    releaseFirstWrite()
    const [resultA, resultB] = await Promise.all([first, second])

    expect(resultA.ok).toBe(true)
    expect(resultB.ok).toBe(true)
    expect(writeCookieIdentityMock).toHaveBeenCalledTimes(2)
    expect(cookiesSetMock).not.toHaveBeenCalled()
    expect(cookiesRemoveMock.mock.calls.map(([, name]) => name)).toEqual(['old-a', 'old-b'])
    expect(events.indexOf('set:first')).toBeLessThan(events.indexOf('remove:old-b'))
    expect(events.indexOf('copy:second')).toBeGreaterThan(events.indexOf('set:first'))
  })
})

/** An unlocked initialization probe could delete a concurrent import’s localhost/__init cookie. */
describe('cold-init probe on a partition that has never stored a cookie', () => {
  let tmpDir: string
  let events: string[]
  let cookiesSetMock: ReturnType<typeof vi.fn>
  let platformSpy: { mockRestore: () => void }
  let stableSession: object

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-probe-'))
    appGetPathMock.mockReturnValue(join(tmpDir, 'userData'))
    events = []
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    snapshotClearIdentitiesMock
      .mockReset()
      .mockImplementation(async (items: { cookie: Record<string, unknown>; url: string }[]) =>
        items.map(({ cookie: entry, url }) => ({ url, ...entry }))
      )
    writeCookieIdentityMock.mockReset().mockResolvedValue(undefined)

    const partitionDir = join(tmpDir, 'userData', 'Partitions', 'probe-conc')
    cookiesSetMock = vi.fn(async (cookie: { name: string }) => {
      events.push(`set:${cookie.name}`)
    })
    stableSession = {
      cookies: {
        get: vi.fn().mockResolvedValue([]),
        remove: vi.fn(async (_url: string, name: string) => {
          events.push(`remove:${name}`)
        }),
        set: cookiesSetMock,
        // Create the database only after __init is written so the initial flush cannot bypass the probe.
        flushStore: vi.fn(async () => {
          if (events.includes('set:__init')) {
            createChromiumCookieTestDatabase(join(partitionDir, 'Network', 'Cookies'), []).close()
          }
        })
      },
      clearData: vi.fn(async () => {
        events.push('clearData')
      }),
      getStoragePath: () => partitionDir,
      setUserAgent: vi.fn()
    }
    sessionFromPartitionMock.mockReset().mockReturnValue(stableSession)
  })

  afterEach(() => {
    platformSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('cannot write or delete __init while another transaction holds the partition', async () => {
    const source = join(tmpDir, 'Chrome', 'Default', 'Network', 'Cookies')
    createChromiumCookieTestDatabase(source, [
      { domain: '.probe.example', name: 'probe', value: 'v' }
    ]).close()

    const release = await acquireCookieMutationLock(stableSession)

    const running = importCookiesFromBrowser(
      {
        family: 'chrome' as const,
        label: 'Google Chrome',
        cookiesPath: source,
        keychainService: 'Chrome Safe Storage',
        keychainAccount: 'Chrome',
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      },
      'persist:probe-conc'
    )
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(events).not.toContain('set:__init')
    expect(events).not.toContain('remove:__init')

    release()
    await running

    // Verify the probe ran after release, rather than bailing out before the lock.
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: '__init', url: 'https://localhost' })
    )
    expect(events.indexOf('set:__init')).toBeGreaterThanOrEqual(0)
    expect(events.indexOf('remove:__init')).toBeGreaterThan(events.indexOf('set:__init'))
  })
})
