import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLEAN_USER_AGENT,
  createFsState,
  installModuleMocks,
  META_PATH,
  seedMeta,
  seedSitePermissions
} from './__mocks__/browser-session-registry-persistence-fixture'

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
    const profile = await browserSessionRegistry.createProfile('isolated', 'Work Browser')

    expect(profile).not.toBeNull()
    expect(fsState.files.has(profileMetaPath)).toBe(true)
    expect(fsState.files.has(META_PATH)).toBe(false)
    expect(JSON.parse(fsState.files.get(profileMetaPath) ?? '{}').profiles[0]).toMatchObject({
      id: profile!.id,
      partition: profile!.partition,
      label: 'Work Browser'
    })
  })

  it('applies the process identity and request exceptions to new profiles', async () => {
    const fsState = createFsState()
    const { sessionFromPartitionMock, installBrowserSessionUserAgentPolicyMock } =
      installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    await browserSessionRegistry.createProfile('isolated', 'Default identity')

    const profileSession = sessionFromPartitionMock.mock.results.at(-1)?.value
    expect(profileSession.setUserAgent).toHaveBeenCalledWith(CLEAN_USER_AGENT)
    expect(installBrowserSessionUserAgentPolicyMock).toHaveBeenCalledWith(
      profileSession,
      expect.any(Function)
    )
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

    expect(fsState.files.get(META_PATH)).toBe(metaBefore)
    expect(fsState.present.has('/staged/default')).toBe(true)
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

    seedSitePermissions(fsState, { default: { 'https://example.com': { camera: 'allow' } } })

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
    const decisions = new Map<string, boolean>()
    const request = (
      permission: string,
      details: Partial<Electron.PermissionRequest & Electron.MediaAccessPermissionRequest> = {}
    ): void =>
      requestHandler(
        guestWc,
        permission,
        (allowed: boolean) => decisions.set(permission, allowed),
        details
      )

    // Only camera has a saved answer; this guest has no prompt window.
    request('fullscreen')
    request('clipboard-read')
    request('clipboard-sanitized-write')
    request('notifications')
    request('persistent-storage')
    request('geolocation')
    request('media', { mediaTypes: ['video'] })

    await vi.waitFor(() => expect(decisions.size).toBe(7))
    expect(Object.fromEntries(decisions)).toEqual({
      fullscreen: true,
      'clipboard-read': false,
      'clipboard-sanitized-write': true,
      notifications: false,
      'persistent-storage': true,
      geolocation: false,
      media: true
    })
    expect(browserManagerNotifyPermissionDeniedMock).not.toHaveBeenCalled()

    requestHandler(guestWc, 'mediaKeySystem', permissionCallback, {
      requestingUrl: 'https://widget.example.net/embed',
      isMainFrame: false
    })
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
      guestWebContentsId: 401,
      permission: 'mediaKeySystem',
      rawUrl: 'https://widget.example.net/embed'
    })

    browserManagerNotifyPermissionDeniedMock.mockClear()
    requestHandler(guestWc, 'mediaKeySystem', permissionCallback, { isMainFrame: true })
    requestHandler(guestWc, 'mediaKeySystem', permissionCallback, {
      requestingUrl: '',
      isMainFrame: false
    })
    expect(
      browserManagerNotifyPermissionDeniedMock.mock.calls.map(([args]) => args.rawUrl)
    ).toEqual(['https://example.com/account', 'https://example.com/account'])

    browserManagerNotifyPermissionDeniedMock.mockClear()
    requestHandler(guestWc, 'mediaKeySystem', permissionCallback, {
      requestingUrl: 'about:blank',
      isMainFrame: false
    })
    expect(browserManagerNotifyPermissionDeniedMock).toHaveBeenCalledWith({
      guestWebContentsId: 401,
      permission: 'mediaKeySystem',
      rawUrl: ''
    })
    expect(checkHandler(null, 'fullscreen', '')).toBe(true)
    expect(checkHandler(null, 'clipboard-read', 'https://example.com')).toBe(false)
    expect(checkHandler(null, 'clipboard-sanitized-write', '')).toBe(true)
    expect(checkHandler(null, 'notifications', 'https://example.com')).toBe(false)
    expect(checkHandler(null, 'persistent-storage', '')).toBe(true)
    expect(checkHandler(null, 'geolocation', 'https://example.com')).toBe(false)
    expect(checkHandler(guestWc, 'media', '', { mediaType: 'video' })).toBe(true)
    expect(checkHandler(guestWc, 'media', '', { mediaType: 'audio' })).toBe(false)

    requestHandler(guestWc, 'storage-access', permissionCallback, {})
    expect(permissionCallback).toHaveBeenLastCalledWith(true)
    expect(checkHandler(null, 'storage-access', '')).toBe(true)

    // Related Website Sets gate top-level storage access; Orca has no such data source.
    requestHandler(guestWc, 'top-level-storage-access', permissionCallback, {})
    expect(permissionCallback).toHaveBeenLastCalledWith(false)
    expect(checkHandler(null, 'top-level-storage-access', '')).toBe(false)

    expect(
      browserManagerNotifyPermissionDeniedMock.mock.calls.map(([args]) => args.permission)
    ).toEqual(['mediaKeySystem', 'top-level-storage-access'])
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

    seedSitePermissions(fsState, { default: { 'https://example.com': { camera: 'allow' } } })
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
