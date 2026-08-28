import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fromFrameMock, getRendererContextForGuestMock, sessionFromPartitionMock } = vi.hoisted(
  () => ({
    fromFrameMock: vi.fn(),
    getRendererContextForGuestMock: vi.fn(),
    sessionFromPartitionMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => {
      throw new Error('userData unavailable in test')
    })
  },
  session: { fromPartition: sessionFromPartitionMock },
  systemPreferences: {
    askForMediaAccess: vi.fn(),
    getMediaAccessStatus: vi.fn(() => 'granted')
  },
  webContents: { fromFrame: fromFrameMock }
}))

vi.mock('./browser-manager', () => ({
  browserManager: {
    getRendererContextForGuest: getRendererContextForGuestMock,
    handleGuestWillDownload: vi.fn(),
    installCertificateRequestGuard: vi.fn(),
    notifyPermissionDenied: vi.fn(),
    removeCertificateRequestGuard: vi.fn()
  }
}))

import { browserSessionRegistry } from './browser-session-registry'
import {
  cancelAllBrowserWebAuthnAccountRequests,
  respondToBrowserWebAuthnAccountRequest
} from './browser-webauthn-account-picker'

type MockSession = Electron.Session & EventEmitter

function mockSession(): MockSession {
  return Object.assign(new EventEmitter(), {
    clearCache: vi.fn().mockResolvedValue(undefined),
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    setDevicePermissionHandler: vi.fn(),
    setDisplayMediaRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn()
  }) as unknown as MockSession
}

function mockWebContents(id: number): Electron.WebContents & EventEmitter {
  return Object.assign(new EventEmitter(), {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  }) as unknown as Electron.WebContents & EventEmitter
}

function accountDetails(frame: Electron.WebFrameMain): Electron.SelectWebauthnAccountDetails {
  return {
    relyingPartyId: 'accounts.example.com',
    frame,
    accounts: [{ credentialId: 'personal' }, { credentialId: 'work' }]
  }
}

describe('browser WebAuthn profile deletion', () => {
  const sessionsByPartition = new Map<string, MockSession>()

  beforeEach(() => {
    sessionsByPartition.clear()
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockImplementation((partition: string) => {
      const existing = sessionsByPartition.get(partition)
      if (existing) {
        return existing
      }
      const created = mockSession()
      sessionsByPartition.set(partition, created)
      return created
    })
    fromFrameMock.mockReset()
    getRendererContextForGuestMock.mockReset()
  })

  afterEach(async () => {
    cancelAllBrowserWebAuthnAccountRequests()
    for (const profile of browserSessionRegistry.listProfiles()) {
      if (profile.scope !== 'default') {
        await browserSessionRegistry.deleteProfile(profile.id)
      }
    }
  })

  it('leaves another session pending when a profile is deleted', async () => {
    const firstProfile = browserSessionRegistry.createProfile('isolated', 'First')
    const secondProfile = browserSessionRegistry.createProfile('isolated', 'Second')
    expect(firstProfile).not.toBeNull()
    expect(secondProfile).not.toBeNull()

    const firstSession = sessionsByPartition.get(firstProfile!.partition)!
    const secondSession = sessionsByPartition.get(secondProfile!.partition)!
    const firstFrame = {} as Electron.WebFrameMain
    const secondFrame = {} as Electron.WebFrameMain
    const firstGuest = mockWebContents(101)
    const secondGuest = mockWebContents(102)
    const firstRenderer = mockWebContents(201)
    const secondRenderer = mockWebContents(202)
    fromFrameMock.mockImplementation((frame) => (frame === firstFrame ? firstGuest : secondGuest))
    getRendererContextForGuestMock.mockImplementation((guestId: number) =>
      guestId === firstGuest.id
        ? { browserPageId: 'first-page', renderer: firstRenderer }
        : { browserPageId: 'second-page', renderer: secondRenderer }
    )
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()
    const firstHandler = firstSession.listeners('select-webauthn-account')[0]
    const secondHandler = secondSession.listeners('select-webauthn-account')[0]

    void firstHandler({ preventDefault: vi.fn() }, accountDetails(firstFrame), firstCallback)
    void secondHandler({ preventDefault: vi.fn() }, accountDetails(secondFrame), secondCallback)

    await expect(browserSessionRegistry.deleteProfile(firstProfile!.id)).resolves.toBe(true)
    await vi.waitFor(() => expect(firstCallback).toHaveBeenCalledWith(null))
    firstGuest.emit('destroyed')
    firstRenderer.emit('render-process-gone')
    expect(firstCallback).toHaveBeenCalledOnce()
    expect(secondCallback).not.toHaveBeenCalled()

    const secondRequest = vi.mocked(secondRenderer.send).mock.calls[0][1]
    expect(
      respondToBrowserWebAuthnAccountRequest(secondRenderer, {
        requestId: secondRequest.requestId,
        credentialId: 'work'
      })
    ).toBe(true)
    await vi.waitFor(() => expect(secondCallback).toHaveBeenCalledWith('work'))
    expect(secondCallback).toHaveBeenCalledOnce()
  })
})
