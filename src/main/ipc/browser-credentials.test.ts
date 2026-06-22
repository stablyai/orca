import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, removeHandler: removeHandlerMock }
}))
vi.mock('../browser/password-import-service', () => ({
  detectPasswordImportBrowsers: vi
    .fn()
    .mockReturnValue([
      { family: 'chrome', label: 'Google Chrome', profiles: [], selectedProfile: 'Default' }
    ]),
  importPasswordsFromBrowser: vi.fn().mockReturnValue({
    ok: true,
    browserLabel: 'Google Chrome',
    profileLabel: 'Default',
    added: 2,
    skipped: 1,
    invalid: 0
  })
}))

import { registerBrowserCredentialHandlers } from './browser-credentials'
import { importPasswordsFromBrowser } from '../browser/password-import-service'

function handlerFor(channel: string) {
  return handleMock.mock.calls.find(([c]) => c === channel)?.[1]
}

const trustedSender = { id: 1 } as never
const untrustedSender = { id: 2 } as never

let vault: Record<string, ReturnType<typeof vi.fn>>
let browserManager: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  vi.clearAllMocks()
  handleMock.mockReset()
  vault = {
    reveal: vi.fn().mockReturnValue('pw'),
    matchesForOrigin: vi.fn().mockReturnValue([{ id: 'e1', username: 'me' }]),
    markUsed: vi.fn(),
    listAll: vi.fn().mockReturnValue([{ id: 'e1', username: 'me' }]),
    save: vi.fn().mockReturnValue({ outcome: 'saved', entry: { id: 'e1' } }),
    add: vi.fn().mockReturnValue({ id: 'e2', username: 'new' }),
    update: vi.fn().mockReturnValue({ id: 'e1', username: 'updated' }),
    delete: vi.fn().mockReturnValue(true),
    status: vi.fn().mockReturnValue({ available: true })
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

  it('reveal: untrusted sender returns null and vault.reveal is not called', async () => {
    const result = await handlerFor('browser:credentials:reveal')!(
      { sender: untrustedSender },
      { id: 'e1' }
    )
    expect(result).toBeNull()
    expect(vault.reveal).not.toHaveBeenCalled()
  })

  it('reveal: trusted sender returns the plaintext value from vault.reveal', async () => {
    vault.reveal.mockReturnValue('secret')
    const result = await handlerFor('browser:credentials:reveal')!(
      { sender: trustedSender },
      { id: 'e1' }
    )
    expect(result).toBe('secret')
    expect(vault.reveal).toHaveBeenCalledWith('e1')
  })

  it('save: untrusted sender returns safe default and vault.save is not called', async () => {
    const result = await handlerFor('browser:credentials:save')!(
      { sender: untrustedSender },
      { origin: 'https://example.com', username: 'me', password: 'pw' }
    )
    expect(result).toEqual({ outcome: 'unchanged', entry: null })
    expect(vault.save).not.toHaveBeenCalled()
  })

  it('delete: untrusted sender returns false and vault.delete is not called', async () => {
    const result = await handlerFor('browser:credentials:delete')!(
      { sender: untrustedSender },
      { id: 'e1' }
    )
    expect(result).toBe(false)
    expect(vault.delete).not.toHaveBeenCalled()
  })

  it('injectBridge: untrusted sender returns false and browserManager.injectPasswordBridge is not called', async () => {
    const result = await handlerFor('browser:credentials:injectBridge')!(
      { sender: untrustedSender },
      { browserTabId: 't1', token: 'tok', enabled: true }
    )
    expect(result).toBe(false)
    expect(browserManager.injectPasswordBridge).not.toHaveBeenCalled()
  })

  it('rejects untrusted detectImportBrowsers', async () => {
    const r = await handlerFor('browser:credentials:detectImportBrowsers')!({
      sender: untrustedSender
    })
    expect(r).toEqual([])
  })

  it('imports from browser for a trusted caller', async () => {
    const r = await handlerFor('browser:credentials:importFromBrowser')!(
      { sender: trustedSender },
      { browserFamily: 'chrome' }
    )
    expect(r).toMatchObject({ ok: true, added: 2 })
  })

  it('rejects untrusted importFromBrowser', async () => {
    const r = await handlerFor('browser:credentials:importFromBrowser')!(
      { sender: untrustedSender },
      { browserFamily: 'chrome' }
    )
    expect(r).toEqual({ ok: false, reason: 'untrusted' })
    // the service must not run for untrusted callers
    expect(importPasswordsFromBrowser).not.toHaveBeenCalled()
  })
})
