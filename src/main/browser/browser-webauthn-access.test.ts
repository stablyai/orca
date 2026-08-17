import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestAccountMock, cancelSessionAccountRequestsMock } = vi.hoisted(() => ({
  requestAccountMock: vi.fn(),
  cancelSessionAccountRequestsMock: vi.fn()
}))

vi.mock('./browser-webauthn-account-picker', () => ({
  requestBrowserWebAuthnAccount: requestAccountMock,
  cancelBrowserWebAuthnAccountRequestsForSession: cancelSessionAccountRequestsMock
}))

import { installBrowserWebAuthnAccessHandlers } from './browser-webauthn-access'

describe('browser WebAuthn access', () => {
  beforeEach(() => {
    requestAccountMock.mockReset()
    cancelSessionAccountRequestsMock.mockReset()
  })

  it('dispatches multi-account assertions to the account picker', async () => {
    let selectHandler:
      | ((
          event: Electron.Event,
          details: Electron.SelectWebauthnAccountDetails,
          callback: (credentialId?: string | null) => void
        ) => Promise<void>)
      | undefined
    const browserSession = {
      setDevicePermissionHandler: vi.fn(),
      removeListener: vi.fn(),
      on: vi.fn((eventName: string, listener: unknown) => {
        if (eventName === 'select-webauthn-account') {
          selectHandler = listener as typeof selectHandler
        }
      })
    } as unknown as Electron.Session
    const details = {
      relyingPartyId: 'example.com',
      frame: {} as Electron.WebFrameMain,
      accounts: [{ credentialId: 'first' }, { credentialId: 'second' }]
    }
    const callback = vi.fn()
    requestAccountMock.mockResolvedValue('second')

    installBrowserWebAuthnAccessHandlers(browserSession)
    await selectHandler?.(
      { preventDefault: vi.fn() } as unknown as Electron.Event,
      details,
      callback
    )

    expect(requestAccountMock).toHaveBeenCalledWith(details, browserSession)
    expect(callback).toHaveBeenCalledOnce()
    expect(callback).toHaveBeenCalledWith('second')
  })
})
