import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  shellOpenExternalMock,
  askForMediaAccessMock,
  getMediaAccessStatusMock,
  isTrustedAccessibilityClientMock,
  getMacosFullDiskAccessStatusMock,
  terminalHostsStatusMock,
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
    terminalHostsStatusMock: vi.fn(async () => 'denied'),
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

vi.mock('../macos-permissions/macos-full-disk-access-status', () => ({
  getMacosFullDiskAccessStatus: getMacosFullDiskAccessStatusMock
}))
vi.mock('../daemon/permissions/daemon-full-disk-access-status', () => ({
  getTerminalHostsFullDiskAccessStatus: terminalHostsStatusMock
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
