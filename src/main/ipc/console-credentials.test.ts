import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ipcState = vi.hoisted(() => ({
  handleHandlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      ipcState.handleHandlers.set(channel, handler)
    }
  }
}))

const getConsoleCredentialMock = vi.hoisted(() => vi.fn())
const setConsoleCredentialMock = vi.hoisted(() => vi.fn())
const clearConsoleCredentialMock = vi.hoisted(() => vi.fn())

const isTrustedUIRendererMock = vi.hoisted(() => vi.fn())

vi.mock('../claude-accounts/service', () => ({
  // Mock is implicit via mocking getRuntimeAuth on the claudeAccounts mock
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

import { registerConsoleCredentialHandlers } from './console-credentials'
import type { ClaudeAccountService } from '../claude-accounts/service'
import type { ClaudeRuntimeAuthService } from '../claude-accounts/runtime-auth-service'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invokeFrom<T>(channel, { sender: {} }, ...args)
}

async function invokeFrom<T>(channel: string, event: unknown, ...args: unknown[]): Promise<T> {
  const handler = ipcState.handleHandlers.get(channel)
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`)
  }
  return (await handler(event, ...args)) as T
}

describe('registerConsoleCredentialHandlers', () => {
  let mockRuntimeAuth: Partial<ClaudeRuntimeAuthService>
  let mockClaudeAccounts: Partial<ClaudeAccountService>

  beforeEach(() => {
    ipcState.handleHandlers.clear()
    getConsoleCredentialMock.mockReset()
    setConsoleCredentialMock.mockReset()
    clearConsoleCredentialMock.mockReset()
    isTrustedUIRendererMock.mockReset().mockReturnValue(true)

    mockRuntimeAuth = {
      getConsoleCredential: getConsoleCredentialMock,
      setConsoleCredential: setConsoleCredentialMock,
      clearConsoleCredential: clearConsoleCredentialMock
    }

    mockClaudeAccounts = {
      getRuntimeAuth: vi.fn(() => mockRuntimeAuth as ClaudeRuntimeAuthService)
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers the three console credential channels', () => {
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)
    expect(ipcState.handleHandlers.has('consoleCredentials:setCredential')).toBe(true)
    expect(ipcState.handleHandlers.has('consoleCredentials:getCredential')).toBe(true)
    expect(ipcState.handleHandlers.has('consoleCredentials:clearCredential')).toBe(true)
  })

  it('setCredential handler calls setConsoleCredential and returns success', async () => {
    getConsoleCredentialMock.mockResolvedValue(undefined)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ success: boolean; error?: string }>(
      'consoleCredentials:setCredential',
      'test-api-key'
    )

    expect(result).toEqual({ success: true })
    expect(setConsoleCredentialMock).toHaveBeenCalledWith('test-api-key')
  })

  it('setCredential handler returns error when setConsoleCredential throws', async () => {
    const error = new Error('Failed to store')
    setConsoleCredentialMock.mockRejectedValue(error)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ success: boolean; error?: string }>(
      'consoleCredentials:setCredential',
      'test-api-key'
    )

    expect(result).toEqual({ success: false, error: 'Failed to store' })
  })

  it('getCredential handler calls getConsoleCredential and returns apiKey', async () => {
    getConsoleCredentialMock.mockResolvedValue('stored-api-key')
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ apiKey?: string | null; error?: string }>(
      'consoleCredentials:getCredential'
    )

    expect(result).toEqual({ apiKey: 'stored-api-key' })
    expect(getConsoleCredentialMock).toHaveBeenCalled()
  })

  it('getCredential handler returns null apiKey when getConsoleCredential returns null', async () => {
    getConsoleCredentialMock.mockResolvedValue(null)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ apiKey?: string | null; error?: string }>(
      'consoleCredentials:getCredential'
    )

    expect(result).toEqual({ apiKey: null })
  })

  it('getCredential handler returns error when getConsoleCredential throws', async () => {
    const error = new Error('Decryption failed')
    getConsoleCredentialMock.mockRejectedValue(error)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ apiKey?: string | null; error?: string }>(
      'consoleCredentials:getCredential'
    )

    expect(result).toEqual({ error: 'Decryption failed' })
  })

  it('clearCredential handler calls clearConsoleCredential and returns success', async () => {
    clearConsoleCredentialMock.mockResolvedValue(undefined)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ success: boolean; error?: string }>(
      'consoleCredentials:clearCredential'
    )

    expect(result).toEqual({ success: true })
    expect(clearConsoleCredentialMock).toHaveBeenCalled()
  })

  it('clearCredential handler returns error when clearConsoleCredential throws', async () => {
    const error = new Error('Permission denied')
    clearConsoleCredentialMock.mockRejectedValue(error)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    const result = await invoke<{ success: boolean; error?: string }>(
      'consoleCredentials:clearCredential'
    )

    expect(result).toEqual({ success: false, error: 'Permission denied' })
  })

  it('refuses untrusted renderers before reading or mutating a credential', async () => {
    isTrustedUIRendererMock.mockReturnValue(false)
    registerConsoleCredentialHandlers(mockClaudeAccounts as ClaudeAccountService)

    await expect(
      invokeFrom<{ success: boolean }>(
        'consoleCredentials:setCredential',
        { sender: {} },
        'test-api-key'
      )
    ).resolves.toEqual({ success: false })
    await expect(
      invokeFrom<{ apiKey?: string }>('consoleCredentials:getCredential', { sender: {} })
    ).resolves.toEqual({})
    await expect(
      invokeFrom<{ success: boolean }>('consoleCredentials:clearCredential', { sender: {} })
    ).resolves.toEqual({ success: false })

    expect(setConsoleCredentialMock).not.toHaveBeenCalled()
    expect(getConsoleCredentialMock).not.toHaveBeenCalled()
    expect(clearConsoleCredentialMock).not.toHaveBeenCalled()
  })
})
