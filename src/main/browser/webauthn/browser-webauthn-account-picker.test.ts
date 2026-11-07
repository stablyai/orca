import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { fromFrameMock, getRendererContextForGuestMock } = vi.hoisted(() => ({
  fromFrameMock: vi.fn(),
  getRendererContextForGuestMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { fromFrame: fromFrameMock }
}))

vi.mock('../browser-manager', () => ({
  browserManager: { getRendererContextForGuest: getRendererContextForGuestMock }
}))
import {
  cancelAllBrowserWebAuthnAccountRequests,
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

  it('keeps sibling and successor requests independent of a retired document', async () => {
    const retiredGuest = mockWebContents(101)
    const siblingGuest = mockWebContents(102)
    const renderer = mockWebContents(103)
    getRendererContextForGuestMock.mockImplementation((guestId: number) => ({
      browserPageId: `page-${guestId}`,
      renderer
    }))
    const browserSession = mockSession()
    const requestIdAt = (index: number): string =>
      vi.mocked(renderer.send).mock.calls[index][1].requestId

    fromFrameMock.mockReturnValueOnce(retiredGuest)
    const retired = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    fromFrameMock.mockReturnValueOnce(siblingGuest)
    const sibling = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    const [retiredId, siblingId] = [requestIdAt(0), requestIdAt(1)]

    retiredGuest.emit('did-navigate')
    await expect(retired).resolves.toBeNull()
    fromFrameMock.mockReturnValueOnce(retiredGuest)
    const successor = requestBrowserWebAuthnAccount(accountDetails(), browserSession)
    const successorId = requestIdAt(3)

    expect(
      respondToBrowserWebAuthnAccountRequest(renderer, {
        requestId: retiredId,
        credentialId: 'credential-1'
      })
    ).toBe(false)
    expect(
      respondToBrowserWebAuthnAccountRequest(renderer, {
        requestId: successorId,
        credentialId: 'credential-2'
      })
    ).toBe(true)
    expect(
      respondToBrowserWebAuthnAccountRequest(renderer, {
        requestId: siblingId,
        credentialId: 'credential-1'
      })
    ).toBe(true)
    await expect(successor).resolves.toBe('credential-2')
    await expect(sibling).resolves.toBe('credential-1')
  })
})
