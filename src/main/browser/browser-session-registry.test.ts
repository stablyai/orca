import { beforeEach, describe, expect, it, vi } from 'vitest'

const { sessionFromPartitionMock, askForMediaAccessMock, getMediaAccessStatusMock } = vi.hoisted(
  () => ({
    sessionFromPartitionMock: vi.fn(),
    askForMediaAccessMock: vi.fn(),
    getMediaAccessStatusMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  session: {
    fromPartition: sessionFromPartitionMock
  },
  systemPreferences: {
    askForMediaAccess: askForMediaAccessMock,
    getMediaAccessStatus: getMediaAccessStatusMock
  }
}))

vi.mock('./browser-manager', () => ({
  browserManager: {
    notifyPermissionDenied: vi.fn(),
    handleGuestWillDownload: vi.fn(),
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn()
  }
}))

import { browserSessionRegistry } from './browser-session-registry'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { setupClientHintsOverride } from './browser-session-ua'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'
import {
  DEFAULT_LOCAL_ORCA_PROFILE_ID,
  getOrcaProfileBrowserDefaultPartition,
  getOrcaProfileBrowserSessionPartition
} from '../../shared/orca-profiles'

describe('BrowserSessionRegistry', () => {
  beforeEach(() => {
    sessionFromPartitionMock.mockReset()
    askForMediaAccessMock.mockReset()
    getMediaAccessStatusMock.mockReset()
    askForMediaAccessMock.mockResolvedValue(true)
    getMediaAccessStatusMock.mockReturnValue('granted')
    sessionFromPartitionMock.mockReturnValue({
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('has a default profile on construction', () => {
    const defaultProfile = browserSessionRegistry.getDefaultProfile()
    expect(defaultProfile.id).toBe('default')
    expect(defaultProfile.scope).toBe('default')
    expect(defaultProfile.partition).toBe(ORCA_BROWSER_PARTITION)
  })

  it('allows the default partition', () => {
    expect(browserSessionRegistry.isAllowedPartition(ORCA_BROWSER_PARTITION)).toBe(true)
  })

  it('rejects unknown partitions', () => {
    expect(browserSessionRegistry.isAllowedPartition('persist:evil-partition')).toBe(false)
  })

  it('creates an isolated profile with a unique partition', () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Test Isolated')
    expect(profile).not.toBeNull()
    expect(profile!.scope).toBe('isolated')
    expect(profile!.partition).toMatch(/^persist:orca-browser-session-/)
    expect(profile!.partition).not.toBe(ORCA_BROWSER_PARTITION)
    expect(profile!.label).toBe('Test Isolated')
    expect(profile!.source).toBeNull()
  })

  it('rejects creating a profile with scope default', () => {
    const profile = browserSessionRegistry.createProfile('default', 'Sneaky')
    expect(profile).toBeNull()
  })

  it('rejects invalid user-agent modes at the registry boundary', () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Invalid UA', {
      userAgentMode: 'rotating' as never
    })
    expect(profile).toBeNull()
  })

  it('allows created profile partitions', () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Allowed')
    expect(profile).not.toBeNull()
    expect(browserSessionRegistry.isAllowedPartition(profile!.partition)).toBe(true)
  })

  it('creates an imported profile', () => {
    const profile = browserSessionRegistry.createProfile('imported', 'My Import')
    expect(profile).not.toBeNull()
    expect(profile!.scope).toBe('imported')
    expect(profile!.partition).toMatch(/^persist:orca-browser-session-/)
  })

  it('resolves partition for a known profile', () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Resolve Test')
    expect(profile).not.toBeNull()
    expect(browserSessionRegistry.resolvePartition(profile!.id)).toBe(profile!.partition)
  })

  it('resolves default partition for null/undefined profileId', () => {
    expect(browserSessionRegistry.resolvePartition(null)).toBe(ORCA_BROWSER_PARTITION)
    expect(browserSessionRegistry.resolvePartition(undefined)).toBe(ORCA_BROWSER_PARTITION)
  })

  it('resolves default partition for unknown profileId', () => {
    expect(browserSessionRegistry.resolvePartition('nonexistent')).toBe(ORCA_BROWSER_PARTITION)
  })

  it('strictly resolves known profile partitions without downgrading unknown profiles', () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Strict Resolve')
    expect(profile).not.toBeNull()

    expect(browserSessionRegistry.resolveKnownPartition(null)).toBe(ORCA_BROWSER_PARTITION)
    expect(browserSessionRegistry.resolveKnownPartition(undefined)).toBe(ORCA_BROWSER_PARTITION)
    expect(browserSessionRegistry.resolveKnownPartition('default')).toBe(ORCA_BROWSER_PARTITION)
    expect(browserSessionRegistry.resolveKnownPartition(profile!.id)).toBe(profile!.partition)
    expect(browserSessionRegistry.resolveKnownPartition('missing-profile')).toBeNull()
  })

  it('lists all profiles', () => {
    const before = browserSessionRegistry.listProfiles().length
    browserSessionRegistry.createProfile('isolated', 'List Test')
    const after = browserSessionRegistry.listProfiles()
    expect(after.length).toBe(before + 1)
  })

  it('updates profile source', () => {
    const profile = browserSessionRegistry.createProfile('imported', 'Source Test')
    expect(profile).not.toBeNull()
    const updated = browserSessionRegistry.updateProfileSource(profile!.id, {
      browserFamily: 'edge',
      importedAt: Date.now()
    })
    expect(updated).not.toBeNull()
    expect(updated!.source?.browserFamily).toBe('edge')
  })

  it('updates profile source with comet family', () => {
    const profile = browserSessionRegistry.createProfile('imported', 'Comet Source Test')
    expect(profile).not.toBeNull()
    const updated = browserSessionRegistry.updateProfileSource(profile!.id, {
      browserFamily: 'comet',
      importedAt: Date.now()
    })
    expect(updated).not.toBeNull()
    expect(updated!.source?.browserFamily).toBe('comet')
  })

  it('deletes a non-default profile', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Delete Test')
    expect(profile).not.toBeNull()
    expect(browserSessionRegistry.isAllowedPartition(profile!.partition)).toBe(true)
    const deleted = await browserSessionRegistry.deleteProfile(profile!.id)
    expect(deleted).toBe(true)
    expect(browserSessionRegistry.isAllowedPartition(profile!.partition)).toBe(false)
    expect(browserSessionRegistry.getProfile(profile!.id)).toBeNull()
  })

  it('clears session policy callbacks when deleting a profile', async () => {
    const profile = browserSessionRegistry.createProfile('isolated', 'Policy Delete Test')
    expect(profile).not.toBeNull()
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    const downloadHandler = mockSession.on.mock.calls.find(
      ([eventName]) => eventName === 'will-download'
    )?.[1]

    await expect(browserSessionRegistry.deleteProfile(profile!.id)).resolves.toBe(true)

    expect(mockSession.removeListener).toHaveBeenCalledWith('will-download', downloadHandler)
    expect(mockSession.setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
    expect(mockSession.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
    expect(mockSession.setDevicePermissionHandler).toHaveBeenLastCalledWith(null)
    expect(mockSession.setDisplayMediaRequestHandler).toHaveBeenLastCalledWith(null)
  })

  it('refuses to delete the default profile', async () => {
    const deleted = await browserSessionRegistry.deleteProfile('default')
    expect(deleted).toBe(false)
    expect(browserSessionRegistry.getDefaultProfile()).not.toBeNull()
  })

  it('hydrates profiles from persisted data', () => {
    const fakeProfile = {
      id: '00000000-0000-0000-0000-000000000001',
      scope: 'imported' as const,
      partition: 'persist:orca-browser-session-00000000-0000-0000-0000-000000000001',
      label: 'Hydrated',
      source: { browserFamily: 'manual' as const, importedAt: 1000 }
    }
    browserSessionRegistry.hydrateFromPersisted([fakeProfile])
    expect(browserSessionRegistry.getProfile('00000000-0000-0000-0000-000000000001')).not.toBeNull()
    expect(browserSessionRegistry.isAllowedPartition(fakeProfile.partition)).toBe(true)
  })

  it('rejects a persisted profile whose partition belongs to a different profile id', () => {
    const profileId = '00000000-0000-4000-8000-000000000021'
    const claimedPartition = 'persist:orca-browser-session-00000000-0000-4000-8000-000000000022'

    browserSessionRegistry.hydrateFromPersisted([
      {
        id: profileId,
        scope: 'isolated',
        partition: claimedPartition,
        label: 'Conflicting identity',
        source: null,
        userAgentMode: 'native'
      }
    ])

    expect(browserSessionRegistry.getProfile(profileId)).toBeNull()
    expect(browserSessionRegistry.isAllowedPartition(claimedPartition)).toBe(false)
  })

  it('sets up session policies for new partitions', () => {
    browserSessionRegistry.createProfile('isolated', 'Policy Test')
    expect(sessionFromPartitionMock).toHaveBeenCalled()
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    expect(mockSession?.setPermissionRequestHandler).toHaveBeenCalled()
    expect(mockSession?.setPermissionCheckHandler).toHaveBeenCalled()
    expect(mockSession?.setDevicePermissionHandler).toHaveBeenCalled()
  })

  it('auto-grants pointer lock for browser partitions', () => {
    browserSessionRegistry.createProfile('isolated', 'Pointer Lock Test')
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    const requestHandler = mockSession.setPermissionRequestHandler.mock.calls[0][0]
    const checkHandler = mockSession.setPermissionCheckHandler.mock.calls[0][0]
    const callback = vi.fn()
    const guestWc = { id: 7, getURL: vi.fn(() => 'https://example.com/') }

    requestHandler(guestWc, 'pointerLock', callback, {})

    expect(callback).toHaveBeenCalledWith(true)
    expect(checkHandler(null, 'pointerLock', '', {})).toBe(true)
  })

  it('auto-grants storage-access for isolated partitions', () => {
    // Why: mirrors the pointerLock precedent directly above — the default-partition suite does not
    // reach this install path.
    browserSessionRegistry.createProfile('isolated', 'Storage Access Test')
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    const requestHandler = mockSession.setPermissionRequestHandler.mock.calls[0][0]
    const checkHandler = mockSession.setPermissionCheckHandler.mock.calls[0][0]
    const callback = vi.fn()
    const guestWc = { id: 7, getURL: vi.fn(() => 'https://example.com/') }

    requestHandler(guestWc, 'storage-access', callback, {})

    expect(callback).toHaveBeenCalledWith(true)
    expect(checkHandler(null, 'storage-access', '', {})).toBe(true)
    expect(checkHandler(null, 'top-level-storage-access', '', {})).toBe(false)
  })

  it('routes media permission requests through macOS TCC for isolated partitions', async () => {
    // Why: verify the parallel fix to the default partition — isolated/imported
    // profiles must also defer media permission checks to macOS instead of
    // denying outright, otherwise pages inside them still hit NotAllowedError
    // after the user grants Camera/Microphone to Orca.
    browserSessionRegistry.createProfile('isolated', 'Media Test')
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    const requestHandler = mockSession.setPermissionRequestHandler.mock.calls[0][0]
    const checkHandler = mockSession.setPermissionCheckHandler.mock.calls[0][0]

    const cb = vi.fn()
    const guestWc = { id: 7, getURL: vi.fn(() => 'https://example.com/') }
    requestHandler(guestWc, 'media', cb, { mediaTypes: ['video'] })
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith(true))

    expect(checkHandler(null, 'media', '', { mediaType: 'video' })).toBe(true)
    expect(checkHandler(null, 'notifications', '', {})).toBe(true)
    expect(checkHandler(null, 'persistent-storage', '', {})).toBe(true)
    expect(checkHandler(null, 'geolocation', '', {})).toBe(false)
  })

  it('wires WebAuthn device selection for isolated partitions', () => {
    browserSessionRegistry.createProfile('isolated', 'Security Key Test')
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    const devicePermissionHandler = mockSession.setDevicePermissionHandler.mock.calls[0][0]
    const checkHandler = mockSession.setPermissionCheckHandler.mock.calls[0][0]

    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'https://github.com',
        device: { collections: [{ usagePage: 0xf1d0 }] }
      })
    ).toBe(true)
    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'http://[::1]:5173',
        device: { collections: [{ usagePage: 0xf1d0 }] }
      })
    ).toBe(true)
    expect(
      devicePermissionHandler({
        deviceType: 'hid',
        origin: 'https://github.com',
        device: { collections: [{ usagePage: 1 }] }
      })
    ).toBe(false)
    expect(checkHandler(null, 'hid', '', { securityOrigin: 'https://github.com' })).toBe(true)

    const selectHidHandler = mockSession.on.mock.calls.find(
      ([eventName]) => eventName === 'select-hid-device'
    )?.[1]
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

    const selectWebAuthnHandler = mockSession.on.mock.calls.find(
      ([eventName]) => eventName === 'select-webauthn-account'
    )?.[1]
    const webAuthnCallback = vi.fn()
    selectWebAuthnHandler(
      { preventDefault: vi.fn() },
      { accounts: [{ credentialId: 'credential-1' }] },
      webAuthnCallback
    )
    expect(webAuthnCallback).toHaveBeenCalledWith('credential-1')
  })

  it('uses profile-owned partitions for non-default Orca profiles', () => {
    const orcaProfileId = 'local-work'
    browserSessionRegistry.configureForOrcaProfile({
      orcaProfileId,
      profileDirectory: '/profiles/local-work'
    })

    expect(browserSessionRegistry.getDefaultProfile().partition).toBe(
      getOrcaProfileBrowserDefaultPartition(orcaProfileId)
    )
    expect(browserSessionRegistry.isAllowedPartition(ORCA_BROWSER_PARTITION)).toBe(false)

    const profile = browserSessionRegistry.createProfile('isolated', 'Work Browser')
    expect(profile).not.toBeNull()
    expect(profile!.partition).toBe(
      getOrcaProfileBrowserSessionPartition(orcaProfileId, profile!.id)
    )

    browserSessionRegistry.configureForOrcaProfile({
      orcaProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
      profileDirectory: '/profiles/local-default'
    })
  })

  describe('setupClientHintsOverride', () => {
    it('overrides sec-ch-ua headers for Edge UA', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      const edgeUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36 Edg/147.0.3210.5'

      setupClientHintsOverride(mockSess, edgeUa)

      expect(onBeforeSendHeaders).toHaveBeenCalledWith(
        { urls: ['https://*/*'] },
        expect.any(Function)
      )

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener(
        { requestHeaders: { 'sec-ch-ua': 'old', 'sec-ch-ua-full-version-list': 'old' } },
        callback
      )
      const modified = callback.mock.calls[0][0].requestHeaders
      expect(modified['sec-ch-ua']).toContain('Microsoft Edge')
      expect(modified['sec-ch-ua']).toContain('"147"')
      expect(modified['sec-ch-ua-full-version-list']).toContain('147.0.3210.5')
    })

    it('overrides sec-ch-ua headers for Chrome UA', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      const chromeUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'

      setupClientHintsOverride(mockSess, chromeUa)

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener({ requestHeaders: { 'sec-ch-ua': 'old' } }, callback)
      const modified = callback.mock.calls[0][0].requestHeaders
      expect(modified['sec-ch-ua']).toContain('Google Chrome')
      expect(modified['sec-ch-ua']).not.toContain('Microsoft Edge')
    })

    it('registers handler even for non-Chrome UA but leaves sec-ch-ua untouched off auth hosts', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never

      // Why: the Google-auth Firefox switch must install regardless of the base UA.
      setupClientHintsOverride(mockSess, 'Mozilla/5.0 (compatible; MSIE 10.0)')

      expect(onBeforeSendHeaders).toHaveBeenCalledWith(
        { urls: ['https://*/*'] },
        expect.any(Function)
      )
      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener({ url: 'https://example.com/', requestHeaders: { 'sec-ch-ua': 'old' } }, callback)
      expect(callback.mock.calls[0][0].requestHeaders['sec-ch-ua']).toBe('old')
    })

    it('presents a Firefox UA and strips client hints on Google auth hosts', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      setupClientHintsOverride(
        mockSess,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'
      )

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener(
        {
          url: 'https://accounts.google.com/v3/signin/identifier',
          requestHeaders: {
            'User-Agent': 'Chrome/147',
            'sec-ch-ua': 'old',
            'sec-ch-ua-full-version-list': 'old',
            'sec-ch-ua-platform': '"macOS"'
          }
        },
        callback
      )
      const modified = callback.mock.calls[0][0].requestHeaders
      expect(modified['User-Agent']).toMatch(/Firefox\/\d/)
      expect(modified['User-Agent']).not.toContain('Chrome')
      expect(modified['sec-ch-ua']).toBeUndefined()
      expect(modified['sec-ch-ua-full-version-list']).toBeUndefined()
      expect(modified['sec-ch-ua-platform']).toBeUndefined()
    })

    it('strips client hints on a cross-host request that carries the Firefox auth UA', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      setupClientHintsOverride(
        mockSess,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'
      )

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      // Subresource/XHR to a non-auth Google host while the auth document is on
      // screen: the WebContents Firefox UA leaks onto the request header.
      listener(
        {
          url: 'https://play.google.com/log',
          requestHeaders: {
            'User-Agent': googleAuthUserAgent(),
            'sec-ch-ua': 'old',
            'sec-ch-ua-full-version-list': 'old',
            'sec-ch-ua-platform': '"macOS"',
            'sec-ch-ua-mobile': '?0'
          }
        },
        callback
      )
      const modified = callback.mock.calls[0][0].requestHeaders
      // UA stays Firefox and every client hint is dropped — one consistent identity.
      expect(modified['User-Agent']).toBe(googleAuthUserAgent())
      expect(modified['sec-ch-ua']).toBeUndefined()
      expect(modified['sec-ch-ua-full-version-list']).toBeUndefined()
      expect(modified['sec-ch-ua-platform']).toBeUndefined()
      expect(modified['sec-ch-ua-mobile']).toBeUndefined()
    })

    it('keeps the clean Chrome identity on cross-host requests that carry the Chrome UA', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      const chromeUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'
      setupClientHintsOverride(mockSess, chromeUa)

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      // Regression guard: non-Google sites (Cloudflare) must keep Chrome hints.
      listener(
        {
          url: 'https://example.com/api',
          requestHeaders: { 'User-Agent': chromeUa, 'sec-ch-ua': 'old' }
        },
        callback
      )
      expect(callback.mock.calls[0][0].requestHeaders['sec-ch-ua']).toContain('Google Chrome')
    })

    it('does not strip hints for the Firefox UA when googleAuthOverride is disabled', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      const chromeUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'
      setupClientHintsOverride(mockSess, chromeUa, { googleAuthOverride: false })

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener(
        {
          url: 'https://play.google.com/log',
          requestHeaders: { 'User-Agent': googleAuthUserAgent(), 'sec-ch-ua': 'old' }
        },
        callback
      )
      // Imported-native profiles never install the Firefox switch, so the strip
      // branch stays inert and hints are aligned to Chrome instead.
      expect(callback.mock.calls[0][0].requestHeaders['sec-ch-ua']).toContain('Google Chrome')
    })

    it('keeps Chrome client hints on Google app subdomains (not auth hosts)', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      setupClientHintsOverride(
        mockSess,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'
      )

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener(
        { url: 'https://myaccount.google.com/', requestHeaders: { 'sec-ch-ua': 'old' } },
        callback
      )
      expect(callback.mock.calls[0][0].requestHeaders['sec-ch-ua']).toContain('Google Chrome')
    })

    it('keeps an imported native UA on auth hosts while aligning its Chrome hints', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      const importedUa =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.6890.3 Safari/537.36'
      setupClientHintsOverride(mockSess, importedUa, { googleAuthOverride: false })

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener(
        {
          url: 'https://accounts.google.com/v3/signin/identifier',
          requestHeaders: { 'User-Agent': importedUa, 'sec-ch-ua': 'old' }
        },
        callback
      )
      const modified = callback.mock.calls[0][0].requestHeaders
      expect(modified['User-Agent']).toBe(importedUa)
      expect(modified['sec-ch-ua']).toContain('Google Chrome')
    })

    it('leaves non-Client-Hints headers unchanged', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never
      setupClientHintsOverride(mockSess, 'Mozilla/5.0 Chrome/147.0.0.0 Safari/537.36')

      const callback = vi.fn()
      const listener = onBeforeSendHeaders.mock.calls[0][1]
      listener(
        { requestHeaders: { Cookie: 'abc=123', 'sec-ch-ua': 'old', Accept: 'text/html' } },
        callback
      )
      const modified = callback.mock.calls[0][0].requestHeaders
      expect(modified.Cookie).toBe('abc=123')
      expect(modified.Accept).toBe('text/html')
    })
  })
})
