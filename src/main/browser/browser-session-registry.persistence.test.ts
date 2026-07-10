import { beforeEach, describe, expect, it, vi } from 'vitest'

const USER_DATA = '/user-data'
const META_PATH = `${USER_DATA}/browser-session-meta.json`

type FsState = {
  files: Map<string, string>
  present: Set<string>
}

function fsKey(pathValue: string): string {
  return pathValue.replaceAll('\\', '/')
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
      const sourceKey = fsKey(src)
      const destinationKey = fsKey(dst)
      if (copyFailures.has(sourceKey)) {
        throw new Error(`copy fail for ${src}`)
      }
      fsState.present.add(destinationKey)
      const value = fsState.files.get(sourceKey)
      if (value !== undefined) {
        fsState.files.set(destinationKey, value)
      }
    }),
    existsSync: vi.fn((p: string) => fsState.present.has(fsKey(p))),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn((p: string) => {
      const v = fsState.files.get(fsKey(p))
      if (v === undefined) {
        throw new Error('ENOENT')
      }
      return v
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const sourceKey = fsKey(from)
      const destinationKey = fsKey(to)
      const v = fsState.files.get(sourceKey)
      if (v === undefined) {
        throw new Error('ENOENT')
      }
      fsState.files.set(destinationKey, v)
      fsState.present.add(destinationKey)
      fsState.files.delete(sourceKey)
      fsState.present.delete(sourceKey)
    }),
    unlinkSync: vi.fn((p: string) => {
      const key = fsKey(p)
      fsState.present.delete(key)
      fsState.files.delete(key)
    }),
    writeFileSync: vi.fn((p: string, data: string | Uint8Array) => {
      const value = typeof data === 'string' ? data : Buffer.from(data).toString('utf-8')
      const key = fsKey(p)
      fsState.files.set(key, value)
      fsState.present.add(key)
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

  it('replays pending cookies into an existing Network database', async () => {
    const stagedPath = '/staged/network-import'
    const networkPath = '/user-data/Partitions/orca-browser/Network/Cookies'
    const legacyPath = '/user-data/Partitions/orca-browser/Cookies'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      pendingCookieDbPath: stagedPath,
      profiles: []
    })
    fsState.files.set(stagedPath, 'imported cookies')
    fsState.files.set(networkPath, 'old cookies')
    fsState.present.add(stagedPath)
    fsState.present.add(networkPath)

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.applyPendingCookieImport()

    expect(fsState.files.get(networkPath)).toBe('imported cookies')
    expect(fsState.present.has(legacyPath)).toBe(false)
  })

  it('persists new browser session profiles under the active Orca profile directory', async () => {
    const fsState = createFsState()
    const profileMetaPath = '/user-data/profiles/local-work/browser-session-meta.json'

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.configureForOrcaProfile({
      orcaProfileId: 'local-work',
      profileDirectory: '/user-data/profiles/local-work'
    })
    const profile = browserSessionRegistry.createProfile('isolated', 'Work Browser')

    expect(profile).not.toBeNull()
    expect(fsState.files.has(profileMetaPath)).toBe(true)
    expect(fsState.files.has(META_PATH)).toBe(false)
    expect(JSON.parse(fsState.files.get(profileMetaPath) ?? '{}').profiles[0]).toMatchObject({
      id: profile!.id,
      partition: profile!.partition,
      label: 'Work Browser'
    })
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
    requestHandler(guestWc, 'persistent-storage', permissionCallback)
    requestHandler(guestWc, 'geolocation', permissionCallback)
    requestHandler(guestWc, 'media', permissionCallback, { mediaTypes: ['video'] })

    await vi.waitFor(() =>
      expect(permissionCallback.mock.calls).toEqual([
        [true],
        [true],
        [true],
        [true],
        [true],
        [false],
        [true]
      ])
    )
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
      guestWebContentsId: 401,
      permission: 'geolocation',
      rawUrl: 'https://example.com/account'
    })
    expect(
      browserManagerNotifyPermissionDeniedMock.mock.calls.map(([args]) => args.permission)
    ).toEqual(['geolocation'])
    expect(checkHandler(null, 'fullscreen', '')).toBe(true)
    expect(checkHandler(null, 'clipboard-read', '')).toBe(true)
    expect(checkHandler(null, 'clipboard-sanitized-write', '')).toBe(true)
    expect(checkHandler(null, 'notifications', '')).toBe(true)
    expect(checkHandler(null, 'persistent-storage', '')).toBe(true)
    expect(checkHandler(null, 'geolocation', '')).toBe(false)
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
