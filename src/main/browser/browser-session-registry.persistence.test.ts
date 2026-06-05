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
  browserManagerHandleGuestWillDownloadMock: ReturnType<typeof vi.fn>
  browserManagerNotifyPermissionDeniedMock: ReturnType<typeof vi.fn>
  requestSystemMediaAccessMock: ReturnType<typeof vi.fn>
} {
  const sessionFromPartitionMock = vi.fn((partition: string) => ({
    partition,
    setUserAgent: vi.fn(),
    getUserAgent: vi.fn(() => 'Mozilla/5.0 Electron/31 Orca'),
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    clearCache: vi.fn().mockResolvedValue(undefined)
  }))
  const setupClientHintsOverrideMock = vi.fn()
  const browserManagerHandleGuestWillDownloadMock = vi.fn()
  const browserManagerNotifyPermissionDeniedMock = vi.fn()
  const requestSystemMediaAccessMock = vi.fn().mockResolvedValue(true)

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
      notifyPermissionDenied: browserManagerNotifyPermissionDeniedMock,
      handleGuestWillDownload: browserManagerHandleGuestWillDownloadMock
    }
  }))
  vi.doMock('./browser-media-access', () => ({
    hasSystemMediaAccess: vi.fn(() => true),
    requestSystemMediaAccess: requestSystemMediaAccessMock
  }))
  vi.doMock('./browser-session-ua', () => ({
    cleanElectronUserAgent: vi.fn((ua: string) => ua.replace(/\s*Electron\/\S+/, '')),
    setupClientHintsOverride: setupClientHintsOverrideMock
  }))

  return {
    sessionFromPartitionMock,
    setupClientHintsOverrideMock,
    browserManagerHandleGuestWillDownloadMock,
    browserManagerNotifyPermissionDeniedMock,
    requestSystemMediaAccessMock
  }
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

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

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

  it('sets up default-partition policies on restore', async () => {
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: []
    })

    const {
      sessionFromPartitionMock,
      browserManagerHandleGuestWillDownloadMock,
      browserManagerNotifyPermissionDeniedMock
    } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const defaultSessions = sessionFromPartitionMock.mock.results
      .filter((_, idx) => sessionFromPartitionMock.mock.calls[idx]?.[0] === 'persist:orca-browser')
      .map((r) => r.value)
    expect(defaultSessions.length).toBeGreaterThan(0)
    const defaultSession = defaultSessions[0]
    const requestHandler = defaultSession.setPermissionRequestHandler.mock.calls[0][0]
    const checkHandler = defaultSession.setPermissionCheckHandler.mock.calls[0][0]
    const guestWc = { id: 401, getURL: vi.fn(() => 'https://example.com/account') }
    const permissionCallback = vi.fn()

    requestHandler(guestWc, 'fullscreen', permissionCallback)
    requestHandler(guestWc, 'clipboard-read', permissionCallback)
    requestHandler(guestWc, 'clipboard-sanitized-write', permissionCallback)
    requestHandler(guestWc, 'notifications', permissionCallback)
    requestHandler(guestWc, 'media', permissionCallback, { mediaTypes: ['video'] })

    await vi.waitFor(() =>
      expect(permissionCallback.mock.calls).toEqual([[true], [true], [true], [false], [true]])
    )
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
      guestWebContentsId: 401,
      permission: 'notifications',
      rawUrl: 'https://example.com/account'
    })
    expect(
      browserManagerNotifyPermissionDeniedMock.mock.calls.map(([args]) => args.permission)
    ).toEqual(['notifications'])
    expect(checkHandler(null, 'fullscreen', '')).toBe(true)
    expect(checkHandler(null, 'clipboard-read', '')).toBe(true)
    expect(checkHandler(null, 'clipboard-sanitized-write', '')).toBe(true)
    expect(checkHandler(null, 'notifications', '')).toBe(false)
    expect(checkHandler(null, 'media', '', { mediaType: 'video' })).toBe(true)
    expect(defaultSession.setDisplayMediaRequestHandler).toHaveBeenCalled()
    const displayMediaHandler = defaultSession.setDisplayMediaRequestHandler.mock.calls[0][0]
    const displayMediaCallback = vi.fn()
    displayMediaHandler(null, displayMediaCallback)
    expect(displayMediaCallback).toHaveBeenCalledWith({ video: undefined, audio: undefined })

    const devicePermissionHandler = defaultSession.setDevicePermissionHandler.mock.calls[0][0]
    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'https://github.com',
        device: { collections: [{ usagePage: 0xf1d0 }] }
      })
    ).toBe(true)
    expect(checkHandler(null, 'hid', '', { securityOrigin: 'https://github.com' })).toBe(true)

    const selectHidHandler = defaultSession.on.mock.calls.find(
      ([eventName]: unknown[]) => eventName === 'select-hid-device'
    )?.[1] as (
      event: { preventDefault: () => void },
      details: {
        deviceList: { deviceId: string; collections?: { usagePage?: number }[] }[]
        frame: { url: string }
      },
      callback: (deviceId?: string) => void
    ) => void
    const hidCallback = vi.fn()
    selectHidHandler(
      { preventDefault: vi.fn() },
      {
        frame: { url: 'https://github.com' },
        deviceList: [
          { deviceId: 'keyboard', collections: [{ usagePage: 1 }] },
          { deviceId: 'security-key', collections: [{ usagePage: 0xf1d0 }] }
        ]
      },
      hidCallback
    )
    expect(hidCallback).toHaveBeenCalledWith('security-key')

    const selectWebAuthnHandler = defaultSession.on.mock.calls.find(
      ([eventName]: unknown[]) => eventName === 'select-webauthn-account'
    )?.[1] as (
      event: { preventDefault: () => void },
      details: { accounts: { credentialId: string }[] },
      callback: (credentialId?: string | null) => void
    ) => void
    const webAuthnCallback = vi.fn()
    selectWebAuthnHandler(
      { preventDefault: vi.fn() },
      { accounts: [{ credentialId: 'credential-1' }] },
      webAuthnCallback
    )
    expect(webAuthnCallback).toHaveBeenCalledWith('credential-1')

    const willDownloadHandler = defaultSession.on.mock.calls.find(
      ([eventName]: unknown[]) => eventName === 'will-download'
    )?.[1] as (
      event: unknown,
      item: { getFilename: () => string },
      webContents: { id: number }
    ) => void
    expect(willDownloadHandler).toBeTypeOf('function')
    const item = { getFilename: vi.fn(() => 'report.pdf') }
    willDownloadHandler({}, item, { id: 402 })
    expect(browserManagerHandleGuestWillDownloadMock).toHaveBeenCalledWith({
      guestWebContentsId: 402,
      item
    })
  })

  it('does not stack default-partition policy handlers on repeated restore', async () => {
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: []
    })

    const { sessionFromPartitionMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const defaultSessions = sessionFromPartitionMock.mock.results
      .filter((_, idx) => sessionFromPartitionMock.mock.calls[idx]?.[0] === 'persist:orca-browser')
      .map((r) => r.value)
    const policySessions = defaultSessions.filter(
      (s) => s.setPermissionRequestHandler.mock.calls.length > 0
    )
    expect(policySessions).toHaveLength(1)
    expect(
      policySessions[0].on.mock.calls.filter(
        ([eventName]: unknown[]) => eventName === 'will-download'
      )
    ).toHaveLength(1)
    expect(
      policySessions[0].on.mock.calls.filter(
        ([eventName]: unknown[]) => eventName === 'select-hid-device'
      )
    ).toHaveLength(1)
    expect(
      policySessions[0].on.mock.calls.filter(
        ([eventName]: unknown[]) => eventName === 'select-webauthn-account'
      )
    ).toHaveLength(1)
  })

  it('notifies when default-partition media permission is denied', async () => {
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: []
    })

    const {
      sessionFromPartitionMock,
      browserManagerNotifyPermissionDeniedMock,
      requestSystemMediaAccessMock
    } = installModuleMocks(fsState)
    requestSystemMediaAccessMock.mockResolvedValue(false)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const defaultSession = sessionFromPartitionMock.mock.results.find(
      (_, idx) => sessionFromPartitionMock.mock.calls[idx]?.[0] === 'persist:orca-browser'
    )?.value
    const requestHandler = defaultSession.setPermissionRequestHandler.mock.calls[0][0]
    const guestWc = { id: 403, getURL: vi.fn(() => 'https://example.com/camera') }
    const callback = vi.fn()

    requestHandler(guestWc, 'media', callback, { mediaTypes: ['video'] })

    await vi.waitFor(() => expect(callback).toHaveBeenCalledWith(false))
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
      guestWebContentsId: 403,
      permission: 'media',
      rawUrl: 'https://example.com/camera'
    })
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

  it('ignores pending cookie imports for invalid persisted profile partitions', async () => {
    const invalidPartition = 'persist:../../outside'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {
        [invalidPartition]: '/staged/evil'
      },
      profiles: [
        {
          id: 'profile-1',
          scope: 'imported',
          partition: invalidPartition,
          label: 'Invalid',
          source: null
        }
      ]
    })
    fsState.present.add('/staged/evil')

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.applyPendingCookieImport()

    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.pendingCookieImports).toEqual({})
    expect(fsState.present.has('/outside/Cookies')).toBe(false)
  })
})
