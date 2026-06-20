import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))

import { registerBrowserCredentialHandlers } from './browser-credentials'

function handlerFor(channel: string) {
  return handleMock.mock.calls.find(([c]) => c === channel)?.[1]
}

const trustedSender = { id: 1 } as never
const untrustedSender = { id: 2 } as never

let vault: Record<string, ReturnType<typeof vi.fn>>
let browserManager: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  handleMock.mockReset()
  vault = {
    reveal: vi.fn().mockReturnValue('pw'),
    matchesForOrigin: vi.fn().mockReturnValue([{ id: 'e1', username: 'me' }]),
    markUsed: vi.fn(),
    listAll: vi.fn().mockReturnValue([{ id: 'e1', username: 'me' }])
  }
  browserManager = {
    fillPasswordField: vi.fn().mockResolvedValue(true),
    injectPasswordBridge: vi.fn().mockResolvedValue(true)
  }
  registerBrowserCredentialHandlers({
    vault: vault as never,
    browserManager: browserManager as never,
    isTrusted: (s: { id: number }) => s.id === 1
  })
})
afterEach(() => vi.restoreAllMocks())

describe('registerBrowserCredentialHandlers', () => {
  it('rejects untrusted callers on matchesForOrigin', async () => {
    const result = await handlerFor('browser:credentials:matchesForOrigin')!(
      { sender: untrustedSender },
      { origin: 'https://github.com' }
    )
    expect(result).toEqual([])
    expect(vault.matchesForOrigin).not.toHaveBeenCalled()
  })

  it('fill decrypts in main and never returns the password', async () => {
    // entry lookup happens via listAll; reveal returns plaintext.
    const result = await handlerFor('browser:credentials:fill')!(
      { sender: trustedSender },
      { browserTabId: 't1', entryId: 'e1', fieldId: 'pf-1' }
    )
    expect(result).toBe(true)
    expect(browserManager.fillPasswordField).toHaveBeenCalledWith('t1', 'pf-1', 'me', 'pw')
    expect(vault.markUsed).toHaveBeenCalledWith('e1')
  })
})
