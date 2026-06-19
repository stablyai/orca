import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, isTrustedUIRendererMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  isTrustedUIRendererMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

import type { CodexAccountService } from '../codex-accounts/service'
import { registerCodexAccountHandlers } from './codex-accounts'

type CodexAccountHandler = (event: { sender: Electron.WebContents }, args?: unknown) => unknown

function getHandler(channel: string): CodexAccountHandler {
  const handler = handleMock.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel
  )?.[1] as CodexAccountHandler | undefined
  if (!handler) {
    throw new Error(`${channel} handler was not registered`)
  }
  return handler
}

describe('registerCodexAccountHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    isTrustedUIRendererMock.mockReset()
  })

  it.each([
    ['codexAccounts:list', 'listAccounts', undefined],
    ['codexAccounts:add', 'addAccount', undefined],
    ['codexAccounts:reauthenticate', 'reauthenticateAccount', { accountId: 'account-1' }],
    ['codexAccounts:cancelReauthentication', 'cancelReauthentication', { accountId: 'account-1' }],
    ['codexAccounts:remove', 'removeAccount', { accountId: 'account-1' }],
    ['codexAccounts:select', 'selectAccount', { accountId: 'account-1' }]
  ])('rejects %s from an untrusted renderer', (channel, method, args) => {
    const serviceMethod = vi.fn()
    registerCodexAccountHandlers({ [method]: serviceMethod } as unknown as CodexAccountService)
    isTrustedUIRendererMock.mockReturnValue(false)

    expect(() => getHandler(channel)({ sender: {} as Electron.WebContents }, args)).toThrow(
      'Unauthorized Codex account sender'
    )
    expect(serviceMethod).not.toHaveBeenCalled()
  })

  it('forwards trusted cancellation to the account service', () => {
    const cancelReauthentication = vi.fn().mockReturnValue(true)
    registerCodexAccountHandlers({ cancelReauthentication } as unknown as CodexAccountService)
    isTrustedUIRendererMock.mockReturnValue(true)

    const result = getHandler('codexAccounts:cancelReauthentication')(
      { sender: {} as Electron.WebContents },
      { accountId: 'account-1' }
    )

    expect(result).toBe(true)
    expect(cancelReauthentication).toHaveBeenCalledWith('account-1')
  })
})
