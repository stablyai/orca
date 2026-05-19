/* eslint-disable max-lines -- Why: SSH IPC session lifecycle tests share a
single mocked Electron/connection harness; splitting them would obscure active
session state that the terminate/disconnect assertions depend on. */
import { describe, expect, it, vi, beforeEach } from 'vitest'

const {
  handleMock,
  mockSshStore,
  mockConnectionManager,
  mockDeployAndLaunchRelay,
  mockForceStopRelayForTarget,
  mockMux,
  mockPtyProvider,
  mockFsProvider,
  mockGitProvider,
  mockPortForwardManager
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
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
    getConnection: vi.fn(),
    getState: vi.fn(),
    disconnectAll: vi.fn()
  },
  mockDeployAndLaunchRelay: vi.fn(),
  mockForceStopRelayForTarget: vi.fn(),
  mockMux: {
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    onNotification: vi.fn(),
    onDispose: vi.fn().mockReturnValue(() => {}),
    request: vi.fn().mockResolvedValue({}),
    notify: vi.fn()
  },
  mockPtyProvider: {
    onData: vi.fn(),
    onExit: vi.fn(),
    onReplay: vi.fn(),
    attach: vi.fn(),
    shutdown: vi.fn()
  },
  mockFsProvider: {},
  mockGitProvider: {},
  mockPortForwardManager: {
    addForward: vi.fn(),
    removeForward: vi.fn(),
    listForwards: vi.fn().mockReturnValue([]),
    removeAllForwards: vi.fn(),
    dispose: vi.fn()
  }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    on: vi.fn(),
    once: vi.fn(),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
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
    constructor() {
      return mockConnectionManager
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
  getSshPtyProvider: vi.fn(),
  getPtyIdsForConnection: vi.fn().mockReturnValue([])
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
      return mockPortForwardManager
    }
  }
}))

import { registerSshHandlers } from './ssh'
import type { SshTarget } from '../../shared/ssh-types'
import { getSshPtyProvider, getPtyIdsForConnection } from './pty'

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

  beforeEach(() => {
    handlers.clear()
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
    mockStore.getSshRemotePtyLeases.mockReset().mockReturnValue([])
    mockStore.markSshRemotePtyLease.mockReset()
    mockStore.markSshRemotePtyLeases.mockReset()
    mockStore.removeSshRemotePtyLeases.mockReset()

    mockConnectionManager.connect.mockReset()
    mockConnectionManager.disconnect.mockReset()
    mockConnectionManager.getConnection.mockReset()
    mockConnectionManager.getState.mockReset()
    mockConnectionManager.disconnectAll.mockReset()
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
    mockPtyProvider.shutdown.mockReset()
    mockPortForwardManager.addForward.mockReset()
    mockPortForwardManager.removeForward.mockReset()
    mockPortForwardManager.listForwards.mockReset().mockReturnValue([])
    mockPortForwardManager.removeAllForwards.mockReset()
    mockPortForwardManager.dispose.mockReset()
    vi.mocked(getSshPtyProvider).mockReset()
    vi.mocked(getPtyIdsForConnection).mockReset().mockReturnValue([])

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
    ).rejects.toThrow('Failed to terminate remote SSH sessions')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith('ssh-1', 'pty-1', 'terminated')
    expect(mockConnectionManager.disconnect).not.toHaveBeenCalledWith('ssh-1')
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
