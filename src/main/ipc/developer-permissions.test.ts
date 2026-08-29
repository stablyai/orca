import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  shellOpenExternalMock,
  askForMediaAccessMock,
  getMediaAccessStatusMock,
  isTrustedAccessibilityClientMock,
  getMacosFullDiskAccessStatusMock,
  execFileMock,
  createSocketMock,
  socketMock,
  socketState
} = vi.hoisted(() => {
  const handleMock = vi.fn()
  const socketState = {
    sendCallback: null as ((error?: Error | null) => void) | null,
    errorListener: null as ((error: Error) => void) | null
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
    getMacosFullDiskAccessStatusMock: vi.fn(),
    execFileMock: vi.fn(),
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

vi.mock('node:child_process', () => ({
  execFile: execFileMock
}))

vi.mock('../macos-full-disk-access-status', () => ({
  getMacosFullDiskAccessStatus: getMacosFullDiskAccessStatusMock
}))

import type { DeveloperPermissionState } from '../../shared/developer-permissions-types'
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
    getMacosFullDiskAccessStatusMock.mockReset()
    getMacosFullDiskAccessStatusMock.mockResolvedValue('denied')
    execFileMock.mockReset()
    execFileMock.mockImplementation((...args: unknown[]) => {
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        const execCallback = callback as () => void
        execCallback()
      }
      return { kill: vi.fn() }
    })
    createSocketMock.mockClear()
    socketState.sendCallback = null
    socketState.errorListener = null
    socketMock.on.mockReset()
    socketMock.on.mockImplementation((event: string, listener: (error: Error) => void) => {
      if (event === 'error') {
        socketState.errorListener = listener
      }
    })
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
        callback: (error?: Error | null) => void
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

  function getStatusHandler(): () => Promise<DeveloperPermissionState[]> {
    const call = handleMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'developerPermissions:getStatus'
    )
    if (!call) {
      throw new Error('developerPermissions:getStatus handler not registered')
    }
    return call[1] as () => Promise<DeveloperPermissionState[]>
  }

  function getOpenSettingsHandler(): (_event: unknown, args: { id: string }) => Promise<void> {
    const call = handleMock.mock.calls.find(
      (c: unknown[]) => c[0] === 'developerPermissions:openSettings'
    )
    if (!call) {
      throw new Error('developerPermissions:openSettings handler not registered')
    }
    return call[1] as (_event: unknown, args: { id: string }) => Promise<void>
  }

  it('returns the Full Disk Access read-probe status', async () => {
    getMacosFullDiskAccessStatusMock.mockResolvedValue('granted')
    registerDeveloperPermissionHandlers()

    const call = handleMock.mock.calls.find(
      (registration: unknown[]) => registration[0] === 'developerPermissions:getStatus'
    )
    const handler = call?.[1] as (() => Promise<unknown>) | undefined

    await expect(handler?.()).resolves.toContainEqual({
      id: 'full-disk-access',
      status: 'granted'
    })
  })

  it('keeps the local-network status unknown when UDP send settles without an error', async () => {
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

  it('keeps local-network status unknown when the prompt trigger receives a socket error', async () => {
    registerDeveloperPermissionHandlers()

    const result = getRequestHandler()({}, { id: 'local-network' })
    socketState.errorListener?.(
      Object.assign(new Error('send EHOSTUNREACH 224.0.0.251:5353'), {
        code: 'EHOSTUNREACH'
      })
    )

    await expect(result).resolves.toEqual({
      id: 'local-network',
      status: 'unknown',
      openedSystemSettings: false
    })
    await expect(getStatusHandler()()).resolves.toContainEqual({
      id: 'local-network',
      status: 'unknown'
    })
  })

  it('opens the standard macOS Local Network settings pane', async () => {
    registerDeveloperPermissionHandlers()

    await getOpenSettingsHandler()({}, { id: 'local-network' })

    expect(shellOpenExternalMock).toHaveBeenCalledWith(
      'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocalNetwork'
    )
  })

  it('settles the automation prompt when osascript hangs', async () => {
    const killMock = vi.fn()
    execFileMock.mockImplementation(() => ({ kill: killMock }))
    registerDeveloperPermissionHandlers()

    const result = getRequestHandler()({}, { id: 'automation' })
    let settled = false
    void result.finally(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(3_000)
    await Promise.resolve()

    expect(settled).toBe(true)
    await expect(result).resolves.toEqual({
      id: 'automation',
      status: 'unknown',
      openedSystemSettings: false
    })
    expect(killMock).toHaveBeenCalled()
  })
})
