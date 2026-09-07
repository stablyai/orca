import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fromFrameMock, getRendererContextForGuestMock } = vi.hoisted(() => ({
  fromFrameMock: vi.fn(),
  getRendererContextForGuestMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { fromFrame: fromFrameMock }
}))

vi.mock('./browser-manager', () => ({
  browserManager: { getRendererContextForGuest: getRendererContextForGuestMock }
}))

import {
  BROWSER_WEBAUTHN_ACCOUNT_PICKER_TIMEOUT_MS,
  cancelAllBrowserWebAuthnAccountRequests,
  cancelBrowserWebAuthnAccountRequests,
  requestBrowserWebAuthnAccount,
  respondToBrowserWebAuthnAccountRequest
} from './browser-webauthn-account-picker'

function mockWebContents(id: number): Electron.WebContents & EventEmitter {
  const contents = new EventEmitter() as Electron.WebContents & EventEmitter
  Object.assign(contents, {
    id,
    isDestroyed: vi.fn(() => false),
    send: vi.fn()
  })
  return contents
}

function accountDetails(): Electron.SelectWebauthnAccountDetails {
  return {
    relyingPartyId: 'accounts.example.com',
    frame: {} as Electron.WebFrameMain,
    accounts: [
      { credentialId: 'credential-1', displayName: 'Personal', name: 'me@example.com' },
      { credentialId: 'credential-2', displayName: 'Work', name: 'me@work.example' }
    ]
  }
}

function mockSession(): Electron.Session {
  return {} as Electron.Session
}

describe('browser WebAuthn account picker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fromFrameMock.mockReset()
    getRendererContextForGuestMock.mockReset()
  })

  afterEach(() => {
    cancelAllBrowserWebAuthnAccountRequests()
    vi.useRealTimers()
  })

  it('returns the credential selected by the owning renderer', async () => {
    const guest = mockWebContents(41)
    const renderer = mockWebContents(42)
    fromFrameMock.mockReturnValue(guest)
    getRendererContextForGuestMock.mockReturnValue({ browserPageId: 'page-1', renderer })

    const selection = requestBrowserWebAuthnAccount(accountDetails(), mockSession())
    const request = vi.mocked(renderer.send).mock.calls[0][1]

    expect(request).toMatchObject({
      browserPageId: 'page-1',
      relyingPartyId: 'accounts.example.com',
      accounts: [
        { credentialId: 'credential-1', displayName: 'Personal', name: 'me@example.com' },
        { credentialId: 'credential-2', displayName: 'Work', name: 'me@work.example' }
      ]
    })
    expect(
      respondToBrowserWebAuthnAccountRequest(renderer, {
        requestId: request.requestId,
        credentialId: 'credential-2'
      })
    ).toBe(true)
    await expect(selection).resolves.toBe('credential-2')
  })

  it('rejects responses from another renderer or with an unoffered credential', async () => {
    const guest = mockWebContents(51)
    const renderer = mockWebContents(52)
    fromFrameMock.mockReturnValue(guest)
    getRendererContextForGuestMock.mockReturnValue({ browserPageId: 'page-2', renderer })

    const selection = requestBrowserWebAuthnAccount(accountDetails(), mockSession())
    const requestId = vi.mocked(renderer.send).mock.calls[0][1].requestId

    expect(
      respondToBrowserWebAuthnAccountRequest(mockWebContents(53), {
        requestId,
        credentialId: 'credential-1'
      })
    ).toBe(false)
    expect(
      respondToBrowserWebAuthnAccountRequest(renderer, {
        requestId,
        credentialId: 'credential-not-offered'
      })
    ).toBe(false)
    expect(
      respondToBrowserWebAuthnAccountRequest(renderer, { requestId, credentialId: null })
    ).toBe(true)
    await expect(selection).resolves.toBeNull()
  })

  it('cancels when the tab closes or the prompt times out', async () => {
    const guest = mockWebContents(61)
    const renderer = mockWebContents(62)
    fromFrameMock.mockReturnValue(guest)
    getRendererContextForGuestMock.mockReturnValue({ browserPageId: 'page-3', renderer })
    const browserSession = mockSession()
    const closedSelection = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    vi.mocked(renderer.send).mockImplementation((channel) => {
      if (channel === 'browser:webauthn-account-request-closed') {
        throw new Error('renderer destroyed during send')
      }
    })

    cancelBrowserWebAuthnAccountRequests('page-3')
    await expect(closedSelection).resolves.toBeNull()

    const timedOutSelection = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    await vi.advanceTimersByTimeAsync(BROWSER_WEBAUTHN_ACCOUNT_PICKER_TIMEOUT_MS)
    await expect(timedOutSelection).resolves.toBeNull()
  })

  it('cancels when the guest or window is destroyed', async () => {
    const guest = mockWebContents(71)
    const renderer = mockWebContents(72)
    fromFrameMock.mockReturnValue(guest)
    getRendererContextForGuestMock.mockReturnValue({ browserPageId: 'page-4', renderer })
    const browserSession = mockSession()
    const guestDestroyed = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    guest.emit('destroyed')
    await expect(guestDestroyed).resolves.toBeNull()

    const windowDestroyed = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    renderer.emit('destroyed')
    await expect(windowDestroyed).resolves.toBeNull()
  })

  it('cancels immediately when the guest or window renderer process exits', async () => {
    const guest = mockWebContents(81)
    const renderer = mockWebContents(82)
    const browserSession = mockSession()
    fromFrameMock.mockReturnValue(guest)
    getRendererContextForGuestMock.mockReturnValue({ browserPageId: 'page-5', renderer })

    const guestCrashed = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    guest.emit('render-process-gone')
    await expect(guestCrashed).resolves.toBeNull()

    const windowCrashed = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    renderer.emit('render-process-gone')
    await expect(windowCrashed).resolves.toBeNull()
  })
})
