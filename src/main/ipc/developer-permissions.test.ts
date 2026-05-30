import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  shellOpenExternalMock,
  askForMediaAccessMock,
  getMediaAccessStatusMock,
  isTrustedAccessibilityClientMock,
  createSocketMock,
  socketMock,
  socketState
} = vi.hoisted(() => {
  const handleMock = vi.fn()
  const socketState = {
    sendCallback: null as (() => void) | null
  }
  const socketMock = {
    on: vi.fn(),
    removeListener: vi.fn(),
    bind: vi.fn(),
    send: vi.fn(),
    close: vi.fn()
  }
  return {
    handleMock,
    shellOpenExternalMock: vi.fn(),
    askForMediaAccessMock: vi.fn(),
    getMediaAccessStatusMock: vi.fn(),
    isTrustedAccessibilityClientMock: vi.fn(),
    createSocketMock: vi.fn(() => socketMock),
    socketMock,
    socketState
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  },
  shell: {
    openExternal: shellOpenExternalMock
  },
  systemPreferences: {
    askForMediaAccess: askForMediaAccessMock,
    getMediaAccessStatus: getMediaAccessStatusMock,
    isTrustedAccessibilityClient: isTrustedAccessibilityClientMock
  }
}))

vi.mock('node:dgram', () => ({
  default: {
    createSocket: createSocketMock
  }
}))

import { registerDeveloperPermissionHandlers } from './developer-permissions'

describe('registerDeveloperPermissionHandlers', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllTimers()
    handleMock.mockClear()
    shellOpenExternalMock.mockClear()
    askForMediaAccessMock.mockReset()
    getMediaAccessStatusMock.mockReset()
    isTrustedAccessibilityClientMock.mockReset()
    createSocketMock.mockClear()
    socketState.sendCallback = null
    socketMock.on.mockClear()
    socketMock.removeListener.mockClear()
    socketMock.bind.mockReset()
    socketMock.bind.mockImplementation((callback: () => void) => callback())
    socketMock.send.mockReset()
    socketMock.send.mockImplementation(
      (
        _message: Buffer,
        _offset: number,
        _length: number,
        _port: number,
        _address: string,
        callback: () => void
      ) => {
        socketState.sendCallback = callback
      }
    )
    socketMock.close.mockClear()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  })

  function getRequestHandler(): (_event: unknown, args: { id: string }) => Promise<unknown> {
    const call = handleMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'developerPermissions:request'
    )
    if (!call) {
      throw new Error('developerPermissions:request handler not registered')
    }
    return call[1] as (_event: unknown, args: { id: string }) => Promise<unknown>
  }

  it('clears the local-network prompt fallback timer when UDP send settles first', async () => {
    registerDeveloperPermissionHandlers()

    const result = getRequestHandler()({}, { id: 'local-network' })
    expect(socketMock.send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    socketState.sendCallback?.()

    await expect(result).resolves.toEqual({
      id: 'local-network',
      status: 'unknown',
      openedSystemSettings: false
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(socketMock.removeListener).toHaveBeenCalledWith('error', expect.any(Function))
    expect(socketMock.close).toHaveBeenCalledTimes(1)
  })
})
