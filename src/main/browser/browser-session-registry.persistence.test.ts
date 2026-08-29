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
  copyFailures = new Set<string>()
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
      handleGuestWillDownload: browserManagerHandleGuestWillDownloadMock,
      installCertificateRequestGuard: vi.fn(),
      removeCertificateRequestGuard: vi.fn()
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
  // This suite models replay with an in-memory filesystem. The real file-backed SQLite merge has
  // dedicated coverage; these fixtures are legacy unmarked images and keep the copy path.
  vi.doMock('./browser-cookie-staged-import', () => ({
    SCOPED_COOKIE_IMPORT_FORMAT: 'scoped-v1',
    applyScopedStagedCookieImport: vi.fn(() => false),
    isScopedStagedCookieImport: vi.fn(() => false),
    removeCookieImportScopeMarker: vi.fn()
  }))
  vi.doMock('../codex-accounts/fs-utils', () => ({
    renameFileWithWindowsRetry: vi.fn((source: string, target: string) => {
      const sourceKey = fsKey(source)
      const targetKey = fsKey(target)
      if (!fsState.present.has(sourceKey)) {
        throw new Error('ENOENT')
      }
      const value = fsState.files.get(sourceKey)
      fsState.present.delete(sourceKey)
      fsState.files.delete(sourceKey)
      fsState.present.add(targetKey)
      if (value !== undefined) {
        fsState.files.set(targetKey, value)
      }
    })
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
    const profile = browserSessionRegistry.createProfile('isolated', 'Work Browser', {
      userAgentMode: 'native'
    })

    expect(profile).not.toBeNull()
    expect(fsState.files.has(profileMetaPath)).toBe(true)
    expect(fsState.files.has(META_PATH)).toBe(false)
    expect(JSON.parse(fsState.files.get(profileMetaPath) ?? '{}').profiles[0]).toMatchObject({
      id: profile!.id,
      partition: profile!.partition,
      label: 'Work Browser',
      userAgentMode: 'native'
    })
  })

  it('keeps UA cleaning as the fallback for profiles without an override', async () => {
    const fsState = createFsState()
    const { sessionFromPartitionMock, setupClientHintsOverrideMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.createProfile('isolated', 'Default identity')

    const profileSession = sessionFromPartitionMock.mock.results.at(-1)?.value
    expect(profileSession.setUserAgent).toHaveBeenCalledWith('Mozilla/5.0 Orca')
    expect(setupClientHintsOverrideMock).toHaveBeenCalledWith(profileSession, 'Mozilla/5.0 Orca')
  })

  it('leaves UA and client hints untouched for native-mode profiles', async () => {
    const fsState = createFsState()
    const { sessionFromPartitionMock, setupClientHintsOverrideMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.createProfile('isolated', 'Google', { userAgentMode: 'native' })

    const profileSession = sessionFromPartitionMock.mock.results.at(-1)?.value
    const { getBrowserSessionUserAgentMode } = await import('./browser-session-user-agent-mode')
    expect(profileSession.setUserAgent).not.toHaveBeenCalled()
    expect(setupClientHintsOverrideMock).not.toHaveBeenCalled()
    expect(getBrowserSessionUserAgentMode(profileSession as never)).toBe('native')
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
    expect(written.pendingCookieDbPath).toBeNull()
    expect(written.pendingCookieImports).toEqual({
      'persist:orca-browser': { format: 'scoped-v1', path: '/staged/default' },
      'persist:orca-browser-session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
        format: 'scoped-v1',
        path: '/staged/imported'
      }
    })
  })

  it('clears only the requested partition and unlinks its staged database files', async () => {
    const otherPartition = 'persist:orca-browser-session-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: '/staged/default',
      pendingCookieImports: {
        'persist:orca-browser': '/staged/default',
        [otherPartition]: '/staged/other'
      },
      profiles: []
    })
    for (const suffix of ['', '-wal', '-shm']) {
      fsState.files.set(`/staged/other${suffix}`, 'db')
      fsState.present.add(`/staged/other${suffix}`)
      fsState.files.set(`/staged/default${suffix}`, 'db')
      fsState.present.add(`/staged/default${suffix}`)
    }

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.clearPendingCookieImport(otherPartition)

    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.pendingCookieImports).toEqual({ 'persist:orca-browser': '/staged/default' })
    // Why: the default partition still has a staged replay, so the legacy pointer must survive.
    expect(written.pendingCookieDbPath).toBe('/staged/default')
    for (const suffix of ['', '-wal', '-shm']) {
      expect(fsState.present.has(`/staged/other${suffix}`)).toBe(false)
      expect(fsState.present.has(`/staged/default${suffix}`)).toBe(true)
    }
  })

  it('drops the legacy pointer when the default partition is the one cleared', async () => {
    const otherPartition = 'persist:orca-browser-session-cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: '/staged/default',
      pendingCookieImports: {
        'persist:orca-browser': '/staged/default',
        [otherPartition]: '/staged/other'
      },
      profiles: []
    })

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.clearPendingCookieImport('persist:orca-browser')

    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.pendingCookieImports).toEqual({ [otherPartition]: '/staged/other' })
    expect(written.pendingCookieDbPath).toBeNull()
  })

  it('is a no-op when the partition has no pending import', async () => {
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: '/staged/default',
      pendingCookieImports: { 'persist:orca-browser': '/staged/default' },
      profiles: []
    })
    fsState.files.set('/staged/default', 'db')
    fsState.present.add('/staged/default')

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')
    const metaBefore = fsState.files.get(META_PATH)

    browserSessionRegistry.clearPendingCookieImport('persist:orca-browser-session-unknown')

    // Why: an absent key must not rewrite meta or touch another partition's staged file.
    expect(fsState.files.get(META_PATH)).toBe(metaBefore)
    expect(fsState.present.has('/staged/default')).toBe(true)
  })

  // Why: imports before Aug 2026 persisted a synthesized source-browser UA
  // (fork imports as a broken Chrome/1.x, Chrome imports as a valid version).
  // Neither may ever be applied again — the engine-derived UA is the only one.
  it('ignores legacy persisted UAs, valid or broken, and applies the engine UA', async () => {
    const importedPartition = 'persist:orca-browser-session-11111111-1111-4111-8111-111111111111'
    const brokenUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/1.158.1 Safari/537.36'
    const validUa = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: { browserFamily: 'arc', importedAt: 1 },
      userAgent: brokenUa,
      userAgentByPartition: {
        'persist:orca-browser': brokenUa,
        [importedPartition]: validUa
      },
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          scope: 'imported',
          partition: importedPartition,
          label: 'Imported',
          source: { browserFamily: 'chrome', importedAt: 1 }
        }
      ]
    })

    const { sessionFromPartitionMock, setupClientHintsOverrideMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const appliedUas = sessionFromPartitionMock.mock.results.flatMap((r) =>
      r.value.setUserAgent.mock.calls.map((c: unknown[]) => c[0])
    )
    expect(appliedUas).not.toContain(brokenUa)
    expect(appliedUas).not.toContain(validUa)
    // Why: every non-native profile falls to Orca's own cleaned engine UA.
    expect(appliedUas.length).toBeGreaterThan(0)
    expect(appliedUas.every((ua) => ua === 'Mozilla/5.0 Orca')).toBe(true)
    expect(
      setupClientHintsOverrideMock.mock.calls.every(
        (c: unknown[]) => c[1] !== brokenUa && c[1] !== validUa
      )
    ).toBe(true)
  })

  it('never applies a legacy persisted UA to a native-mode profile', async () => {
    const importedPartition = 'persist:orca-browser-session-11111111-1111-4111-8111-111111111111'
    const importedUa = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: { [importedPartition]: importedUa },
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          scope: 'imported',
          partition: importedPartition,
          label: 'Imported',
          source: { browserFamily: 'comet', importedAt: 1 },
          userAgentMode: 'native'
        }
      ]
    })

    const { sessionFromPartitionMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const importedSessions = sessionFromPartitionMock.mock.results
      .filter((_, idx) => sessionFromPartitionMock.mock.calls[idx]?.[0] === importedPartition)
      .map((r) => r.value)
    expect(importedSessions.length).toBeGreaterThan(0)
    // Why: native mode means the engine UA stands untouched — no setUserAgent at all.
    expect(importedSessions.every((s) => s.setUserAgent.mock.calls.length === 0)).toBe(true)
    const { getBrowserSessionUserAgentMode } = await import('./browser-session-user-agent-mode')
    expect(
      importedSessions.every(
        (session) => getBrowserSessionUserAgentMode(session as never) === 'native'
      )
    ).toBe(true)
  })

  it('preserves native mode across hydration when no source UA was imported', async () => {
    const importedPartition = 'persist:orca-browser-session-12121212-1212-4121-8121-121212121212'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: '12121212-1212-4121-8121-121212121212',
          scope: 'isolated',
          partition: importedPartition,
          label: 'Google',
          source: null,
          userAgentMode: 'native'
        }
      ]
    })

    const { sessionFromPartitionMock, setupClientHintsOverrideMock } = installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const importedSessions = sessionFromPartitionMock.mock.results
      .filter((_, index) => sessionFromPartitionMock.mock.calls[index]?.[0] === importedPartition)
      .map((result) => result.value)
    expect(importedSessions.length).toBeGreaterThan(0)
    expect(importedSessions.every((sess) => sess.setUserAgent.mock.calls.length === 0)).toBe(true)
    expect(
      setupClientHintsOverrideMock.mock.calls.some(
        ([sess]) => (sess as { partition?: string }).partition === importedPartition
      )
    ).toBe(false)
    const { getBrowserSessionUserAgentMode } = await import('./browser-session-user-agent-mode')
    expect(
      importedSessions.every(
        (session) => getBrowserSessionUserAgentMode(session as never) === 'native'
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

    // A subframe denial must name the requester, not its top-level embedder.
    browserManagerNotifyPermissionDeniedMock.mockClear()
    requestHandler(guestWc, 'geolocation', permissionCallback, {
      requestingUrl: 'https://widget.example.net/embed',
      isMainFrame: false
    })
    await vi.waitFor(() =>
      expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
        guestWebContentsId: 401,
        permission: 'geolocation',
        rawUrl: 'https://widget.example.net/embed'
      })
    )

    // Missing or empty frame URLs fall back to the visible top-level page.
    browserManagerNotifyPermissionDeniedMock.mockClear()
    requestHandler(guestWc, 'geolocation', permissionCallback, { isMainFrame: true })
    await vi.waitFor(() =>
      expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
        guestWebContentsId: 401,
        permission: 'geolocation',
        rawUrl: 'https://example.com/account'
      })
    )

    browserManagerNotifyPermissionDeniedMock.mockClear()
    requestHandler(guestWc, 'geolocation', permissionCallback, {
      requestingUrl: '',
      isMainFrame: false
    })
    await vi.waitFor(() =>
      expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
        guestWebContentsId: 401,
        permission: 'geolocation',
        rawUrl: 'https://example.com/account'
      })
    )

    // Opaque frame URLs have no site Orca can name accurately.
    browserManagerNotifyPermissionDeniedMock.mockClear()
    requestHandler(guestWc, 'geolocation', permissionCallback, {
      requestingUrl: 'about:blank',
      isMainFrame: false
    })
    await vi.waitFor(() =>
      expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
        guestWebContentsId: 401,
        permission: 'geolocation',
        rawUrl: ''
      })
    )
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

    // Why: this session allows unpartitioned third-party cookies, so a cross-site frame already has
    // the access requestStorageAccess() would grant. Denying it protected nothing and only broke
    // sites taking the API's failure path. Red before the grant landed.
    requestHandler(guestWc, 'storage-access', permissionCallback)
    expect(permissionCallback).toHaveBeenLastCalledWith(true)
    expect(checkHandler(null, 'storage-access', '')).toBe(true)

    // Why: requestStorageAccessFor() is a different platform decision — Chromium consults Related
    // Website Sets and has no third-party-cookie auto-grant, and Orca has no such data source. This
    // pins the deliberate denial so a future blanket widening of the allow-set fails loudly.
    requestHandler(guestWc, 'top-level-storage-access', permissionCallback)
    expect(permissionCallback).toHaveBeenLastCalledWith(false)
    expect(checkHandler(null, 'top-level-storage-access', '')).toBe(false)

    // Why: the reported symptom was a user-visible denial notice, so pin the notified list here —
    // storage-access must no longer raise one, while the deliberate top-level denial still does.
    expect(
      browserManagerNotifyPermissionDeniedMock.mock.calls.map(([args]) => args.permission)
    ).toEqual(['geolocation', 'top-level-storage-access'])
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
    guestWc.getURL.mockReturnValue('https://example.com/after-navigation')

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
