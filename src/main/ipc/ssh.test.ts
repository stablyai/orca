/* eslint-disable max-lines -- Why: SSH IPC session lifecycle tests share a
single mocked Electron/connection harness; splitting them would obscure active
session state that the terminate/disconnect assertions depend on. */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  handleMock,
  powerMonitorOffMock,
  powerMonitorOnMock,
  mockSshStore,
  mockConnectionManager,
  mockDeployAndLaunchRelay,
  mockForceStopRelayForTarget,
  mockMux,
  mockPtyProvider,
  mockFsProvider,
  mockGitProvider,
  mockPortForwardManager,
  mockPortScannerCallbacks,
  mockNextConnectionManagers,
  mockNextPortForwardManagers
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  powerMonitorOffMock: vi.fn(),
  powerMonitorOnMock: vi.fn(),
  mockSshStore: {
    listTargets: vi.fn().mockReturnValue([]),
    getTarget: vi.fn(),
    addTarget: vi.fn(),
    updateTarget: vi.fn(),
    removeTarget: vi.fn(),
    importFromSshConfig: vi.fn().mockReturnValue([])
  },
  mockConnectionManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    getConnection: vi.fn(),
    getState: vi.fn(),
    disconnectAll: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  },
  mockDeployAndLaunchRelay: vi.fn(),
  mockForceStopRelayForTarget: vi.fn(),
  mockMux: {
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    onNotification: vi.fn(),
    onRequest: vi.fn().mockReturnValue(() => {}),
    onDispose: vi.fn().mockReturnValue(() => {}),
    request: vi.fn().mockResolvedValue({}),
    notify: vi.fn()
  },
  mockPtyProvider: {
    onData: vi.fn(),
    onExit: vi.fn(),
    onReplay: vi.fn(),
    attach: vi.fn(),
    attachForReconnect: vi.fn().mockResolvedValue({}),
    shutdown: vi.fn()
  },
  mockFsProvider: {},
  mockGitProvider: {},
  mockPortForwardManager: {
    addForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    removeForwardAndWait: vi.fn(),
    listForwards: vi.fn().mockReturnValue([]),
    removeAllForwards: vi.fn(),
    dispose: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  },
  mockPortScannerCallbacks: new Map<string, unknown>(),
  mockNextConnectionManagers: [] as unknown[],
  mockNextPortForwardManagers: [] as unknown[]
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  powerMonitor: {
    on: powerMonitorOnMock,
    off: powerMonitorOffMock
  }
}))

vi.mock('../ssh/ssh-connection-store', () => ({
  SshConnectionStore: class MockSshConnectionStore {
    constructor() {
      return mockSshStore
    }
  }
}))

vi.mock('../ssh/ssh-connection', () => ({
  SshConnectionManager: class MockSshConnectionManager {
    constructor(callbacks: unknown) {
      const manager = (mockNextConnectionManagers.shift() ??
        mockConnectionManager) as typeof mockConnectionManager
      manager.callbacksRef.current = callbacks
      manager.setCallbacks.mockImplementation((nextCallbacks: unknown) => {
        manager.callbacksRef.current = nextCallbacks
      })
      return manager
    }
  }
}))

vi.mock('../ssh/ssh-relay-deploy', () => ({
  deployAndLaunchRelay: mockDeployAndLaunchRelay
}))

vi.mock('../ssh/ssh-relay-reset', () => ({
  forceStopRelayForTarget: mockForceStopRelayForTarget
}))

vi.mock('../ssh/ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    constructor() {
      return mockMux
    }
  }
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('not found'),
  SshPtyProvider: class MockSshPtyProvider {
    constructor() {
      return mockPtyProvider
    }
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    constructor() {
      return mockFsProvider
    }
  }
}))

vi.mock('./pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data),
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  isRendererPtyOutputPaused: vi.fn().mockReturnValue(false)
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {
    constructor() {
      return mockGitProvider
    }
  }
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

vi.mock('../ssh/ssh-port-forward', () => ({
  SshPortForwardManager: class MockPortForwardManager {
    constructor() {
      const manager = (mockNextPortForwardManagers.shift() ??
        mockPortForwardManager) as typeof mockPortForwardManager
      manager.setCallbacks.mockImplementation((callbacks: unknown) => {
        manager.callbacksRef.current = callbacks
      })
      return manager
    }
  }
}))

vi.mock('../ssh/ssh-port-scanner', () => ({
  PortScanner: class MockPortScanner {
    startScanning(targetId: string, _mux: unknown, onChanged: unknown) {
      mockPortScannerCallbacks.set(targetId, onChanged)
    }
    getDetectedPorts() {
      return []
    }
    stopScanning(targetId: string) {
      mockPortScannerCallbacks.delete(targetId)
    }
  }
}))

import { getSshConnectionManager, registerSshHandlers, resetSshHandlerStateForTests } from './ssh'
import { SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, type SshTarget } from '../../shared/ssh-types'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getSshPtyProvider,
  getPtyIdsForConnection
} from './pty'

describe('SSH IPC handlers', () => {
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockStore = {
    getRepos: () => [],
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn(),
    removeSshRemotePtyLeases: vi.fn()
  }
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const createMockWindow = () => ({
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  })
  const createConnectionManagerMock = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    getConnection: vi.fn(),
    getState: vi.fn(),
    disconnectAll: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  })
  const createPortForwardManagerMock = () => ({
    addForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    listForwards: vi.fn().mockReturnValue([]),
    removeAllForwards: vi.fn(),
    dispose: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  })
  type RelayDisposeCallback = (reason: 'shutdown' | 'connection_lost') => void
  const relayReconnectDelaysMs = [500, 1000, 2000, 4000, 8000, 15_000] as const
  const relayLostStabilizedMs = 5_000
  const createRelayLaunchResult = () => ({
    transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
    platform: 'linux-x64'
  })
  const getLatestRelayDisposeCallback = (): RelayDisposeCallback => {
    const calls = mockMux.onDispose.mock.calls
    const callback = calls.at(-1)?.[0] as RelayDisposeCallback | undefined
    expect(callback).toBeDefined()
    return callback!
  }
  const useSlowRelayLaunchOnce = (delayMs: number): void => {
    mockDeployAndLaunchRelay.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(createRelayLaunchResult()), delayMs)
        })
    )
  }

  beforeEach(async () => {
    await resetSshHandlerStateForTests()
    handlers.clear()
    mockNextConnectionManagers.length = 0
    mockNextPortForwardManagers.length = 0
    mockPortScannerCallbacks.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })

    mockSshStore.listTargets.mockReset().mockReturnValue([])
    mockSshStore.getTarget.mockReset()
    mockSshStore.addTarget.mockReset()
    mockSshStore.updateTarget.mockReset()
    mockSshStore.removeTarget.mockReset()
    mockSshStore.importFromSshConfig.mockReset().mockReturnValue([])
    mockWindow.webContents.send.mockReset()
    mockStore.getSshRemotePtyLeases.mockReset().mockReturnValue([])
    mockStore.markSshRemotePtyLease.mockReset()
    mockStore.markSshRemotePtyLeases.mockReset()
    mockStore.removeSshRemotePtyLeases.mockReset()

    mockConnectionManager.connect.mockReset()
    mockConnectionManager.disconnect.mockReset()
    mockConnectionManager.reconnect.mockReset()
    mockConnectionManager.getConnection.mockReset()
    mockConnectionManager.getState.mockReset()
    mockConnectionManager.disconnectAll.mockReset()
    mockConnectionManager.setCallbacks.mockReset()
    mockConnectionManager.callbacksRef.current = null
    mockForceStopRelayForTarget.mockReset().mockResolvedValue(undefined)

    mockDeployAndLaunchRelay.mockReset().mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64'
    })
    mockMux.dispose.mockReset()
    mockMux.isDisposed.mockReset().mockReturnValue(false)
    mockMux.onNotification.mockReset()
    mockMux.onDispose.mockReset().mockReturnValue(() => {})
    mockPtyProvider.onData.mockReset()
    mockPtyProvider.onExit.mockReset()
    mockPtyProvider.onReplay.mockReset()
    mockPtyProvider.attachForReconnect.mockReset().mockResolvedValue({})
    mockPtyProvider.shutdown.mockReset()
    mockPortForwardManager.addForward.mockReset()
    mockPortForwardManager.updateForward.mockReset()
    mockPortForwardManager.removeForward.mockReset()
    mockPortForwardManager.removeForwardAndWait.mockReset()
    mockPortForwardManager.listForwards.mockReset().mockReturnValue([])
    mockPortForwardManager.removeAllForwards.mockReset()
    mockPortForwardManager.dispose.mockReset()
    mockPortForwardManager.setCallbacks.mockReset()
    mockPortForwardManager.callbacksRef.current = null
    powerMonitorOnMock.mockReset()
    powerMonitorOffMock.mockReset()
    vi.mocked(getSshPtyProvider).mockReset()
    vi.mocked(getPtyIdsForConnection).mockReset().mockReturnValue([])
    vi.mocked(clearProviderPtyState).mockReset()
    vi.mocked(deletePtyOwnership).mockReset()

    registerSshHandlers(mockStore as never, () => mockWindow as never)
  })

  it('registers all expected IPC channels', () => {
    const channels = Array.from(handlers.keys())
    expect(channels).toContain('ssh:listTargets')
    expect(channels).toContain('ssh:addTarget')
    expect(channels).toContain('ssh:updateTarget')
    expect(channels).toContain('ssh:removeTarget')
    expect(channels).toContain('ssh:importConfig')
    expect(channels).toContain('ssh:connect')
    expect(channels).toContain('ssh:disconnect')
    expect(channels).toContain('ssh:terminateSessions')
    expect(channels).toContain('ssh:resetRelay')
    expect(channels).toContain('ssh:getState')
    expect(channels).toContain('ssh:testConnection')
  })

  it('ssh:listTargets returns targets from store', async () => {
    const mockTargets: SshTarget[] = [
      { id: 'ssh-1', label: 'Server 1', host: 'srv1.com', port: 22, username: 'admin' }
    ]
    mockSshStore.listTargets.mockReturnValue(mockTargets)

    const result = await handlers.get('ssh:listTargets')!(null, {})
    expect(result).toEqual(mockTargets)
  })

  it('ssh:addTarget calls store.addTarget', async () => {
    const newTarget = {
      label: 'New Server',
      host: 'new.example.com',
      port: 22,
      username: 'deploy'
    }
    const withId = { ...newTarget, id: 'ssh-new' }
    mockSshStore.addTarget.mockReturnValue(withId)

    const result = await handlers.get('ssh:addTarget')!(null, { target: newTarget })
    expect(mockSshStore.addTarget).toHaveBeenCalledWith(newTarget)
    expect(result).toEqual(withId)
  })

  it('ssh:removeTarget calls store.removeTarget', async () => {
    await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:removeTarget removes metadata when disconnect fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockConnectionManager.disconnect.mockRejectedValueOnce(new Error('host unreachable'))
    try {
      await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })

      expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
      expect(mockStore.removeSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1')
      expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('ssh:removeTarget tears down an active relay before deleting the target', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockPortForwardManager.removeAllForwards.mockClear()
    mockConnectionManager.disconnect.mockClear().mockResolvedValue(undefined)

    await handlers.get('ssh:removeTarget')!(null, { id: 'ssh-1' })

    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    expect(mockMux.dispose).toHaveBeenCalledWith('shutdown')
    expect(mockStore.markSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1', 'terminated')
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(mockStore.removeSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1')
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:importConfig returns imported targets', async () => {
    const imported: SshTarget[] = [
      { id: 'ssh-imp', label: 'staging', host: 'staging.com', port: 22, username: '' }
    ]
    mockSshStore.importFromSshConfig.mockReturnValue(imported)

    const result = await handlers.get('ssh:importConfig')!(null, {})
    expect(result).toEqual(imported)
  })

  it('ssh:connect throws for unknown targetId', async () => {
    mockSshStore.getTarget.mockReturnValue(undefined)

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'unknown' })).rejects.toThrow(
      'SSH target "unknown" not found'
    )
  })

  it('ssh:connect calls connection manager', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)
  })

  it('ssh:connect exposes the detected remote platform in public state', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Windows Server',
      host: 'windows.example.com',
      port: 22,
      username: 'deploy'
    }
    const hostPlatform = {
      relayPlatform: 'win32-x64',
      os: 'win32',
      arch: 'x64',
      pathFlavor: 'windows',
      commandDialect: 'powershell',
      pathSeparator: '\\',
      pathDelimiter: ';'
    }
    mockDeployAndLaunchRelay.mockResolvedValueOnce({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      hostPlatform
    })
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0,
      remotePlatform: 'win32'
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        remotePlatform: 'win32'
      }
    })
  })

  it('surfaces relay channel loss while the SSH connection remains alive', async () => {
    vi.useFakeTimers()
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    try {
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
      const onDispose = mockMux.onDispose.mock.calls[0]?.[0] as
        | ((reason: 'shutdown' | 'connection_lost') => void)
        | undefined

      onDispose?.('connection_lost')

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
        targetId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'reconnecting',
          error: 'Relay channel lost. Reconnecting...',
          reconnectAttempt: 1
        }
      })
      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'reconnecting',
        error: 'Relay channel lost. Reconnecting...',
        reconnectAttempt: 1
      })

      await vi.advanceTimersByTimeAsync(500)

      expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
        targetId: 'ssh-1',
        state: {
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        }
      })
      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rebuilds instead of reusing a ready session while relay loss is pending', async () => {
    vi.useFakeTimers()
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    try {
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
      const onDispose = mockMux.onDispose.mock.calls[0]?.[0] as
        | ((reason: 'shutdown' | 'connection_lost') => void)
        | undefined

      onDispose?.('connection_lost')

      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'reconnecting',
        error: 'Relay channel lost. Reconnecting...',
        reconnectAttempt: 1
      })

      mockDeployAndLaunchRelay.mockClear()
      mockPortForwardManager.removeAllForwards.mockClear()

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })

      expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
      expect(mockDeployAndLaunchRelay).toHaveBeenCalled()
      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps counting slow unstable relay reconnects until manual reconnect is required', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    try {
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

      for (const delayMs of relayReconnectDelaysMs) {
        useSlowRelayLaunchOnce(relayLostStabilizedMs + 1)
        getLatestRelayDisposeCallback()('connection_lost')
        await vi.advanceTimersByTimeAsync(delayMs + relayLostStabilizedMs + 1)
        expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0
        })
      }

      getLatestRelayDisposeCallback()('connection_lost')

      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'error',
        error: 'Relay channel kept dropping. Click Reconnect on the SSH target before retrying.',
        reconnectAttempt: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses a fast relay reconnect after the post-ready stabilization window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    try {
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

      getLatestRelayDisposeCallback()('connection_lost')
      await vi.advanceTimersByTimeAsync(relayReconnectDelaysMs[0])
      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })

      await vi.advanceTimersByTimeAsync(relayLostStabilizedMs + 1)
      mockDeployAndLaunchRelay.mockClear()
      mockPortForwardManager.removeAllForwards.mockClear()

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
      expect(mockPortForwardManager.removeAllForwards).not.toHaveBeenCalled()
      expect(mockDeployAndLaunchRelay).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards remote PTY events into the runtime', async () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    const onData = mockPtyProvider.onData.mock.calls[0]?.[0] as
      | ((payload: { id: string; data: string }) => void)
      | undefined
    const onExit = mockPtyProvider.onExit.mock.calls[0]?.[0] as
      | ((payload: { id: string; code: number }) => void)
      | undefined

    onData?.({ id: 'remote-pty', data: 'hello' })
    onExit?.({ id: 'remote-pty', code: 7 })

    expect(runtime.onPtyData).toHaveBeenCalledWith('remote-pty', 'hello', expect.any(Number))
    expect(runtime.onPtyExit).toHaveBeenCalledWith('remote-pty', 7)
  })

  it('preserves active port forwards and live connections across handler re-registration', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    const forward = {
      id: 'pf-1',
      connectionId: 'ssh-1',
      localPort: 4100,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      label: 'app'
    }
    const updatedForward = { ...forward, remotePort: 3001 }
    const newForward = { ...forward, id: 'pf-2', localPort: 4101 }
    const connectedState = {
      targetId: 'ssh-1',
      status: 'connected' as const,
      error: null,
      reconnectAttempt: 0
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue(connectedState)
    mockPortForwardManager.addForward
      .mockResolvedValueOnce(forward)
      .mockResolvedValueOnce(newForward)
    mockPortForwardManager.updateForward.mockResolvedValue(updatedForward)
    mockPortForwardManager.removeForwardAndWait.mockResolvedValue(updatedForward)
    mockPortForwardManager.listForwards.mockReturnValue([forward])

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await handlers.get('ssh:addPortForward')!(null, {
      targetId: 'ssh-1',
      localPort: 4100,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      label: 'app'
    })
    const replacementConnectionManager = createConnectionManagerMock()
    const replacementPortForwardManager = createPortForwardManagerMock()
    mockNextConnectionManagers.push(replacementConnectionManager)
    mockNextPortForwardManagers.push(replacementPortForwardManager)

    registerSshHandlers(mockStore as never, () => createMockWindow() as never)

    expect(getSshConnectionManager()).toBe(mockConnectionManager)
    expect(await handlers.get('ssh:listPortForwards')!(null, { targetId: 'ssh-1' })).toEqual([
      forward
    ])
    mockDeployAndLaunchRelay.mockClear()
    mockPortForwardManager.removeAllForwards.mockClear()

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual(
      connectedState
    )
    expect(mockDeployAndLaunchRelay).not.toHaveBeenCalled()
    expect(mockPortForwardManager.removeAllForwards).not.toHaveBeenCalled()
    expect(await handlers.get('ssh:listPortForwards')!(null, { targetId: 'ssh-1' })).toEqual([
      forward
    ])

    await handlers.get('ssh:updatePortForward')!(null, {
      id: 'pf-1',
      targetId: 'ssh-1',
      localPort: 4100,
      remoteHost: '127.0.0.1',
      remotePort: 3001,
      label: 'app'
    })
    expect(mockPortForwardManager.updateForward).toHaveBeenCalledWith(
      'pf-1',
      conn,
      4100,
      '127.0.0.1',
      3001,
      'app'
    )

    expect(await handlers.get('ssh:removePortForward')!(null, { id: 'pf-1' })).toEqual(
      updatedForward
    )
    await handlers.get('ssh:addPortForward')!(null, {
      targetId: 'ssh-1',
      localPort: 4101,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      label: 'app'
    })
    expect(mockPortForwardManager.addForward).toHaveBeenLastCalledWith(
      'ssh-1',
      conn,
      4101,
      '127.0.0.1',
      3000,
      'app'
    )
    expect(replacementConnectionManager.getConnection).not.toHaveBeenCalled()
    expect(replacementPortForwardManager.listForwards).not.toHaveBeenCalled()
  })

  it('persists desired forwards and broadcasts when an active forward closes unexpectedly', () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy',
      portForwards: [
        {
          localPort: 4100,
          remoteHost: '127.0.0.1',
          remotePort: 3000,
          label: 'app'
        }
      ]
    }
    const forward = {
      id: 'pf-1',
      connectionId: 'ssh-1',
      localPort: 4100,
      remoteHost: '127.0.0.1',
      remotePort: 3000,
      label: 'app'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockPortForwardManager.listForwards.mockReturnValue([])

    const callbacks = mockPortForwardManager.callbacksRef.current as {
      onForwardClosed: (entry: typeof forward, reason: { kind: 'unexpected-exit' }) => void
    }
    callbacks.onForwardClosed(forward, { kind: 'unexpected-exit' })

    expect(mockSshStore.updateTarget).toHaveBeenCalledWith('ssh-1', {
      portForwards: [
        {
          localPort: 4100,
          remoteHost: '127.0.0.1',
          remotePort: 3000,
          label: 'app'
        }
      ]
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:port-forwards-changed', {
      targetId: 'ssh-1',
      forwards: []
    })
  })

  it('disconnects the original session and releases original forwards after re-registration', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockPortForwardManager.removeAllForwards.mockClear()
    mockConnectionManager.disconnect.mockClear().mockResolvedValue(undefined)
    const replacementConnectionManager = createConnectionManagerMock()
    const replacementPortForwardManager = createPortForwardManagerMock()
    mockNextConnectionManagers.push(replacementConnectionManager)
    mockNextPortForwardManagers.push(replacementPortForwardManager)

    registerSshHandlers(mockStore as never, () => createMockWindow() as never)
    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })

    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(replacementPortForwardManager.removeAllForwards).not.toHaveBeenCalled()
    expect(replacementConnectionManager.disconnect).not.toHaveBeenCalled()
  })

  it('refreshes live session callbacks to the newest window, store, and runtime', async () => {
    const firstWindow = createMockWindow()
    const secondWindow = createMockWindow()
    const firstRuntime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    const secondRuntime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => firstWindow as never, firstRuntime as never)
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    const onData = mockPtyProvider.onData.mock.calls[0]?.[0] as
      | ((payload: { id: string; data: string }) => void)
      | undefined
    const onExit = mockPtyProvider.onExit.mock.calls[0]?.[0] as
      | ((payload: { id: string; code: number }) => void)
      | undefined
    const onDetectedPorts = mockPortScannerCallbacks.get('ssh-1') as
      | ((targetId: string, ports: unknown[], platform: string) => void)
      | undefined
    firstWindow.webContents.send.mockClear()
    secondWindow.webContents.send.mockClear()

    registerSshHandlers(mockStore as never, () => secondWindow as never, secondRuntime as never)
    const callbacks = mockConnectionManager.callbacksRef.current as {
      onStateChange: (targetId: string, state: unknown) => void
    }

    callbacks.onStateChange('ssh-1', {
      targetId: 'ssh-1',
      status: 'error',
      error: 'network down',
      reconnectAttempt: 0
    })
    onData?.({ id: 'remote-pty', data: 'hello' })
    onExit?.({ id: 'remote-pty', code: 9 })
    onDetectedPorts?.(
      'ssh-1',
      [{ host: '127.0.0.1', port: 3000, pid: 12, processName: 'node' }],
      'linux-x64'
    )

    expect(firstWindow.webContents.send).not.toHaveBeenCalled()
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'error',
        error: 'network down',
        reconnectAttempt: 0
      }
    })
    expect(secondWindow.webContents.send).toHaveBeenCalledWith(
      'pty:data',
      expect.objectContaining({ id: 'remote-pty', data: 'hello' })
    )
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'remote-pty',
      code: 9
    })
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('ssh:detected-ports-changed', {
      targetId: 'ssh-1',
      ports: expect.arrayContaining([expect.objectContaining({ port: 3000 })])
    })
    expect(secondRuntime.onPtyData).toHaveBeenCalledWith('remote-pty', 'hello', expect.any(Number))
    expect(secondRuntime.onPtyExit).toHaveBeenCalledWith('remote-pty', 9)
    expect(firstRuntime.onPtyData).not.toHaveBeenCalled()
    expect(firstRuntime.onPtyExit).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'ssh-1',
      'remote-pty',
      'terminated'
    )
  })

  it('re-registers without replacing managers when no targets are connected', () => {
    const replacementConnectionManager = createConnectionManagerMock()
    const replacementPortForwardManager = createPortForwardManagerMock()
    mockNextConnectionManagers.push(replacementConnectionManager)
    mockNextPortForwardManagers.push(replacementPortForwardManager)

    const result = registerSshHandlers(mockStore as never, () => createMockWindow() as never)

    expect(result.connectionManager).toBe(mockConnectionManager)
    expect(replacementConnectionManager.setCallbacks).not.toHaveBeenCalled()
    expect(replacementPortForwardManager.dispose).not.toHaveBeenCalled()
    expect(mockNextConnectionManagers).toHaveLength(1)
    expect(mockNextPortForwardManagers).toHaveLength(1)
  })

  it('ssh:disconnect calls connection manager', async () => {
    mockConnectionManager.disconnect.mockResolvedValue(undefined)

    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })

    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:terminateSessions preserves tracking when relay shutdown fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-1'])
    mockPtyProvider.shutdown.mockRejectedValue(new Error('mux down'))

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).rejects.toThrow('Failed to terminate SSH host sessions')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith('ssh-1', 'pty-1', 'terminated')
    expect(mockConnectionManager.disconnect).not.toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:terminateSessions cleans scoped live PTYs while tombstoning raw leases', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-lease', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(mockPtyProvider as never)
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['ssh:ssh-1@@pty-live'])
    mockPtyProvider.shutdown.mockResolvedValue(undefined)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    await handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })

    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-live', {
      immediate: true,
      keepHistory: false
    })
    expect(mockPtyProvider.shutdown).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease', {
      immediate: true,
      keepHistory: false
    })
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:ssh-1@@pty-live')
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:ssh-1@@pty-live')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-live', 'terminated')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-lease', 'terminated')
  })

  it('ssh:terminateSessions ignores expired leases when disconnected', async () => {
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-expired', state: 'expired' }
    ])
    vi.mocked(getSshPtyProvider).mockReturnValue(undefined)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])

    await expect(
      handlers.get('ssh:terminateSessions')!(null, { targetId: 'ssh-1' })
    ).resolves.toBeUndefined()

    expect(mockPtyProvider.shutdown).not.toHaveBeenCalled()
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:resetRelay force-stops the remote relay and expires tracked leases', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'detached' },
      { targetId: 'ssh-1', ptyId: 'pty-expired', state: 'expired' }
    ])
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-2'])

    await handlers.get('ssh:resetRelay')!(null, { targetId: 'ssh-1' })

    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)
    expect(mockForceStopRelayForTarget).toHaveBeenCalledWith(conn, 'ssh-1')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-1', 'expired')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'ssh-1',
      'pty-expired',
      'expired'
    )
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:resetRelay clears scoped live PTYs while expiring raw leases', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-lease', state: 'detached' }
    ])
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['ssh:ssh-1@@pty-live'])

    await handlers.get('ssh:resetRelay')!(null, { targetId: 'ssh-1' })

    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-lease', 'expired')
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:ssh-1@@pty-live')
    expect(clearProviderPtyState).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:ssh-1@@pty-live')
    expect(deletePtyOwnership).toHaveBeenCalledWith('ssh:ssh-1@@pty-lease')
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:resetRelay waits for an in-flight connect before tearing down the session', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    let resolveConnect!: (value: unknown) => void
    const connectResult = new Promise((resolve) => {
      resolveConnect = resolve
    })
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockReturnValue(connectResult)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    const connectPromise = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<unknown>
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1))

    const resetPromise = handlers.get('ssh:resetRelay')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    await Promise.resolve()

    expect(mockPortForwardManager.removeAllForwards).not.toHaveBeenCalled()
    expect(mockForceStopRelayForTarget).not.toHaveBeenCalled()

    resolveConnect(conn)
    await connectPromise
    await resetPromise

    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    expect(mockForceStopRelayForTarget).toHaveBeenCalledWith(conn, 'ssh-1')
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('ssh:connect waits for an in-flight reset before starting a new connection', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const resetConn = {}
    const connectConn = {}
    let resolveForceStop!: () => void
    const forceStopResult = new Promise<void>((resolve) => {
      resolveForceStop = resolve
    })
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(resetConn)
    mockConnectionManager.connect.mockResolvedValue(connectConn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockForceStopRelayForTarget.mockReturnValue(forceStopResult)

    const resetPromise = handlers.get('ssh:resetRelay')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    const connectPromise = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<unknown>

    await vi.waitFor(() => expect(mockForceStopRelayForTarget).toHaveBeenCalledTimes(1))
    await Promise.resolve()

    expect(mockConnectionManager.connect).not.toHaveBeenCalled()

    resolveForceStop()
    await resetPromise
    await connectPromise

    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)
  })

  it('ssh:resetRelay reuses duplicate in-flight resets for the same target', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    let resolveForceStop!: () => void
    let activeForceStops = 0
    let maxConcurrentForceStops = 0
    const forceStopResult = new Promise<void>((resolve) => {
      resolveForceStop = resolve
    })
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockForceStopRelayForTarget.mockImplementation(async () => {
      activeForceStops += 1
      maxConcurrentForceStops = Math.max(maxConcurrentForceStops, activeForceStops)
      await forceStopResult
      activeForceStops -= 1
    })

    const firstReset = handlers.get('ssh:resetRelay')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    const secondReset = handlers.get('ssh:resetRelay')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>

    expect(secondReset).toBe(firstReset)
    await vi.waitFor(() => expect(mockForceStopRelayForTarget).toHaveBeenCalledTimes(1))

    resolveForceStop()
    await Promise.all([firstReset, secondReset])

    expect(mockForceStopRelayForTarget).toHaveBeenCalledTimes(1)
    expect(maxConcurrentForceStops).toBe(1)
    expect(mockConnectionManager.disconnect).toHaveBeenCalledTimes(1)
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('forces active SSH sessions to reconnect when the system resumes from sleep', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    const resumeListener = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1]
    expect(resumeListener).toBeTypeOf('function')

    resumeListener()

    expect(mockConnectionManager.reconnect).toHaveBeenCalledWith('ssh-1')
  })

  it('extends active relay grace while the system is suspending', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockMux.notify.mockClear()

    const suspendListener = powerMonitorOnMock.mock.calls.find(
      ([event]) => event === 'suspend'
    )?.[1]
    expect(suspendListener).toBeTypeOf('function')

    suspendListener()

    expect(mockMux.notify).toHaveBeenCalledWith(SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD, {
      graceTimeSeconds: 0
    })
  })

  it('ssh:resetRelay expires active-session leases instead of marking them terminated', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockStore.markSshRemotePtyLeases.mockClear()
    mockStore.markSshRemotePtyLease.mockClear()
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' }
    ])

    await handlers.get('ssh:resetRelay')!(null, { targetId: 'ssh-1' })

    expect(mockStore.markSshRemotePtyLeases).not.toHaveBeenCalledWith('ssh-1', 'terminated')
    expect(mockStore.markSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1', 'detached')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-1', 'expired')
    expect(mockForceStopRelayForTarget).toHaveBeenCalledWith(conn, 'ssh-1')
  })

  it('ssh:getState returns connection state', async () => {
    const state = {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    mockConnectionManager.getState.mockReturnValue(state)

    const result = await handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })
    expect(result).toEqual(state)
  })
})
