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
    handleGuestWillDownload: vi.fn()
  }
}))

import { browserSessionRegistry } from './browser-session-registry'
import { setupClientHintsOverride } from './browser-session-ua'
import { ORCA_BROWSER_PARTITION } from '../../shared/constants'

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
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
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

  it('sets up session policies for new partitions', () => {
    browserSessionRegistry.createProfile('isolated', 'Policy Test')
    expect(sessionFromPartitionMock).toHaveBeenCalled()
    const mockSession = sessionFromPartitionMock.mock.results[0]?.value
    expect(mockSession?.setPermissionRequestHandler).toHaveBeenCalled()
    expect(mockSession?.setPermissionCheckHandler).toHaveBeenCalled()
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
    expect(checkHandler(null, 'notifications', '', {})).toBe(false)
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

    it('does not register handler for non-Chrome UA', () => {
      const onBeforeSendHeaders = vi.fn()
      const mockSess = { webRequest: { onBeforeSendHeaders } } as never

      setupClientHintsOverride(mockSess, 'Mozilla/5.0 (compatible; MSIE 10.0)')

      expect(onBeforeSendHeaders).not.toHaveBeenCalled()
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
