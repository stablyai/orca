import { beforeEach, describe, expect, it, vi } from 'vitest'

const USER_DATA = '/user-data'
const META_PATH = `${USER_DATA}/browser-session-meta.json`

type FsState = {
  files: Map<string, string>
  present: Set<string>
}

function createFsState(): FsState {
  return { files: new Map(), present: new Set() }
}

function seedMeta(fsState: FsState, meta: unknown): void {
  const raw = JSON.stringify(meta)
  fsState.files.set(META_PATH, raw)
  fsState.present.add(META_PATH)
}

function installModuleMocks(
  fsState: FsState,
  copyFailures: Set<string> = new Set()
): {
  sessionFromPartitionMock: ReturnType<typeof vi.fn>
  setupClientHintsOverrideMock: ReturnType<typeof vi.fn>
} {
  const sessionFromPartitionMock = vi.fn((partition: string) => ({
    partition,
    setUserAgent: vi.fn(),
    getUserAgent: vi.fn(() => 'Mozilla/5.0 Electron/31 Orca'),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined)
  }))
  const setupClientHintsOverrideMock = vi.fn()

  vi.doMock('electron', () => ({
    app: { getPath: vi.fn(() => USER_DATA) },
    session: { fromPartition: sessionFromPartitionMock },
    systemPreferences: {
      askForMediaAccess: vi.fn().mockResolvedValue(true),
      getMediaAccessStatus: vi.fn(() => 'granted')
    }
  }))

  vi.doMock('node:fs', () => ({
    copyFileSync: vi.fn((src: string, dst: string) => {
      if (copyFailures.has(src)) {
        throw new Error(`copy fail for ${src}`)
      }
      fsState.present.add(dst)
      const value = fsState.files.get(src)
      if (value !== undefined) {
        fsState.files.set(dst, value)
      }
    }),
    existsSync: vi.fn((p: string) => fsState.present.has(p)),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((p: string) => {
      const v = fsState.files.get(p)
      if (v === undefined) {
        throw new Error('ENOENT')
      }
      return v
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const v = fsState.files.get(from)
      if (v === undefined) {
        throw new Error('ENOENT')
      }
      fsState.files.set(to, v)
      fsState.present.add(to)
      fsState.files.delete(from)
      fsState.present.delete(from)
    }),
    unlinkSync: vi.fn((p: string) => {
      fsState.present.delete(p)
      fsState.files.delete(p)
    }),
    writeFileSync: vi.fn((p: string, data: string | Uint8Array) => {
      const value = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8')
      fsState.files.set(p, value)
      fsState.present.add(p)
    })
  }))

  vi.doMock('./browser-manager', () => ({
    browserManager: {
      notifyPermissionDenied: vi.fn(),
      handleGuestWillDownload: vi.fn()
    }
  }))
  vi.doMock('./browser-media-access', () => ({
    hasSystemMediaAccess: vi.fn(() => true),
    requestSystemMediaAccess: vi.fn().mockResolvedValue(true)
  }))
  vi.doMock('./browser-session-ua', () => ({
    cleanElectronUserAgent: vi.fn((ua: string) => ua.replace(/\s*Electron\/\S+/, '')),
    setupClientHintsOverride: setupClientHintsOverrideMock
  }))

  return { sessionFromPartitionMock, setupClientHintsOverrideMock }
}

describe('BrowserSessionRegistry persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('migrates and consumes legacy pendingCookieDbPath into default partition replay', async () => {
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      pendingCookieDbPath: '/staged/legacy',
      profiles: []
    })
    fsState.present.add('/staged/legacy')

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.applyPendingCookieImport()

    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.pendingCookieDbPath).toBeNull()
    expect(written.pendingCookieImports).toEqual({})
    expect(fsState.present.has('/user-data/Partitions/orca-browser/Cookies')).toBe(true)
  })

  it('merges partition-keyed pending entries without clobbering unrelated entries', async () => {
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: []
    })

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.setPendingCookieImport('persist:orca-browser', '/staged/default')
    browserSessionRegistry.setPendingCookieImport(
      'persist:orca-browser-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '/staged/imported'
    )

    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.pendingCookieDbPath).toBe('/staged/default')
    expect(written.pendingCookieImports).toEqual({
      'persist:orca-browser': '/staged/default',
      'persist:orca-browser-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': '/staged/imported'
    })
  })

  it('restores persisted UA for non-default partitions', async () => {
    const importedPartition = 'persist:orca-browser-session-11111111-1111-4111-8111-111111111111'
    const importedUa = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'
    const defaultUa = 'Mozilla/5.0 Chrome/119.0.0.0 Safari/537.36'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: defaultUa,
      userAgentByPartition: {
        'persist:orca-browser': defaultUa,
        [importedPartition]: importedUa
      },
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          scope: 'imported',
          partition: importedPartition,
          label: 'Imported',
          source: { browserFamily: 'comet', importedAt: 1 }
        }
      ]
    })

    const { sessionFromPartitionMock, setupClientHintsOverrideMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.restorePersistedUserAgent()

    const importedSessions = sessionFromPartitionMock.mock.results
      .filter((_, idx) => sessionFromPartitionMock.mock.calls[idx]?.[0] === importedPartition)
      .map((r) => r.value)
    expect(importedSessions.length).toBeGreaterThan(0)
    expect(
      importedSessions.some((s) =>
        s.setUserAgent.mock.calls.some((c: unknown[]) => c[0] === importedUa)
      )
    ).toBe(true)
    expect(
      setupClientHintsOverrideMock.mock.calls.some(
        (c: unknown[]) =>
          (c[0] as { partition?: string } | undefined)?.partition === importedPartition &&
          c[1] === importedUa
      )
    ).toBe(true)
  })

  it('keeps failed partition replay pending and removes unrelated missing entries', async () => {
    const importedPartition = 'persist:orca-browser-session-22222222-2222-4222-8222-222222222222'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {
        [importedPartition]: '/staged/imported',
        'persist:orca-browser': '/staged/missing'
      },
      profiles: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          scope: 'imported',
          partition: importedPartition,
          label: 'Imported',
          source: { browserFamily: 'comet', importedAt: 1 }
        }
      ]
    })
    fsState.present.add('/staged/imported')

    installModuleMocks(fsState, new Set(['/staged/imported']))
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.applyPendingCookieImport()

    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.pendingCookieImports).toEqual({ [importedPartition]: '/staged/imported' })
    expect(written.pendingCookieDbPath).toBeNull()
  })
})
