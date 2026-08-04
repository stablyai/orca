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
  mockAcceptSshPtyOutputData,
  mockAcceptSshPtyOutputExit,
  mockMux,
  mockPtyProvider,
  mockFsProvider,
  mockGitProvider,
  mockRegisterSshGitProvider,
  mockPortForwardManager,
  mockPortScannerCallbacks,
  mockListConfigHosts,
  mockResolveConfigHost,
  mockNextConnectionManagers,
  mockNextPortForwardManagers
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  powerMonitorOffMock: vi.fn(),
  powerMonitorOnMock: vi.fn(),
  mockSshStore: {
    listTargets: vi.fn().mockReturnValue([]),
    listSuppressedSshConfigAliases: vi.fn().mockReturnValue([]),
    getTarget: vi.fn(),
    addTarget: vi.fn(),
    updateTarget: vi.fn(),
    removeTarget: vi.fn(),
    importFromSshConfig: vi.fn().mockReturnValue([]),
    lastRepoReadoptions: [] as {
      oldTargetId: string
      newTargetId: string
      repoIds: string[]
    }[]
  },
  mockConnectionManager: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    disconnectConnection: vi.fn(),
    reconnect: vi.fn(),
    getConnection: vi.fn(),
    getState: vi.fn(),
    disconnectAll: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  },
  mockDeployAndLaunchRelay: vi.fn(),
  mockForceStopRelayForTarget: vi.fn(),
  mockAcceptSshPtyOutputData: vi.fn().mockResolvedValue({}),
  mockAcceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  mockMux: {
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false),
    onNotification: vi.fn(),
    onNotificationByMethod: vi.fn().mockReturnValue(() => {}),
    onRequest: vi.fn().mockReturnValue(() => {}),
    onDispose: vi.fn().mockReturnValue(() => {}),
    request: vi.fn().mockResolvedValue({}),
    notify: vi.fn(),
    probeLiveness: vi.fn().mockResolvedValue(false)
  },
  mockPtyProvider: {
    onData: vi.fn(),
    onExit: vi.fn(),
    onReplay: vi.fn(),
    attach: vi.fn(),
    attachForReconnect: vi.fn().mockResolvedValue({}),
    shutdown: vi.fn(),
    providerGeneration: 0
  },
  mockFsProvider: {},
  mockGitProvider: {},
  mockRegisterSshGitProvider: vi.fn(),
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
  mockListConfigHosts: vi.fn().mockReturnValue({
    hosts: [],
    totalHostCount: 0,
    newHostCount: 0,
    matchCount: 0,
    hasMore: false
  }),
  mockResolveConfigHost: vi.fn().mockResolvedValue(null),
  mockNextConnectionManagers: [] as unknown[],
  mockNextPortForwardManagers: [] as unknown[]
}))

vi.mock('../ssh/ssh-config-host-picker', () => ({
  listUserSshConfigHostSummaries: mockListConfigHosts,
  resolveUserSshConfigHost: mockResolveConfigHost
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

vi.mock('./ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: mockAcceptSshPtyOutputData,
  acceptSshPtyOutputExit: mockAcceptSshPtyOutputExit,
  allocateSshPtyProviderGeneration: (() => {
    let generation = 0
    return () => ++generation
  })(),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  applySshPtySourceCancellationProof: vi.fn().mockReturnValue(false),
  applySshPtySourceRecoveryCancellationProof: vi.fn().mockReturnValue(false),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn().mockReturnValue([]),
  installSshPtySourceAckPublisher: vi.fn().mockReturnValue(() => {}),
  installSshPtySourceCancellationPublisher: vi.fn().mockReturnValue(() => {})
}))

vi.mock('../ssh/ssh-connection-store', () => ({
  SshConnectionStore: class MockSshConnectionStore {
    constructor() {
      return mockSshStore
    }
  }
}))

vi.mock('../ssh/ssh-connection-manager', () => ({
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
    constructor(_targetId: unknown, _mux: unknown, _env: unknown, providerGeneration: number) {
      mockPtyProvider.providerGeneration = providerGeneration
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
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  isCurrentPtyExit: vi.fn().mockReturnValue(true),
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
  registerSshGitProvider: mockRegisterSshGitProvider,
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

import {
  detachAllSshSessionsForShutdown,
  getActiveMultiplexer,
  getSshConnectionManager,
  registerSshHandlers,
  resetSshHandlerStateForTests
} from './ssh'
import { RelayVersionMismatchError } from '../ssh/ssh-relay-version-mismatch-error'
import {
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD,
  type SshConnectionState,
  type SshConnectionStatus,
  type SshTarget
} from '../../shared/ssh-types'
import { PTY_CONSUMER_SESSION_PROTOCOL_VERSION } from '../../shared/pty-consumer-session'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../../shared/pty-source-credit-contract'
import type { SshPtyDataCallback } from '../providers/ssh-pty-provider-contract'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getSshPtyProvider,
  getPtyIdsForConnection
} from './pty'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
import { getSshPtyConsumerRecovery } from '../ssh/ssh-pty-consumer-recovery'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'

describe('SSH IPC handlers', () => {
  const relayBuildId = '0.1.0+ipc-test'
  const ipcTestSource = {
    relayPtyId: 'remote-pty',
    spanId: 'ipc-test-delivery:0:5',
    clientGeneration: 1,
    ownerGeneration: 1,
    deliveryToken: 'ipc-test-delivery',
    sourceStartSu: 0,
    sourceEndSu: 5
  } as const
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockStore = {
    getRepos: () => [],
    getSshPtyConsumerRecovery: vi.fn().mockReturnValue(null),
    upsertSshPtyConsumerRecovery: vi.fn(),
    removeSshPtyConsumerRecovery: vi.fn(),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn(),
    markSshRemotePtyLeasesAsync: vi.fn(),
    markSshRemotePtyLeasesAttachedAsync: vi.fn(),
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
    disconnectConnection: vi.fn(),
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
    platform: 'linux-x64',
    serverBuildId: relayBuildId
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
    mockSshStore.lastRepoReadoptions = []
    mockWindow.webContents.send.mockReset()
    mockStore.getSshRemotePtyLeases.mockReset().mockReturnValue([])
    mockStore.markSshRemotePtyLease.mockReset()
    mockStore.markSshRemotePtyLeases.mockReset()
    mockStore.markSshRemotePtyLeasesAsync.mockReset()
    mockStore.markSshRemotePtyLeasesAttachedAsync.mockReset()
    mockStore.removeSshRemotePtyLeases.mockReset()
    mockStore.upsertSshPtyConsumerRecovery.mockReset()

    mockConnectionManager.connect.mockReset()
    mockConnectionManager.disconnect.mockReset()
    mockConnectionManager.disconnectConnection.mockReset().mockResolvedValue(undefined)
    mockConnectionManager.reconnect.mockReset()
    mockConnectionManager.getConnection.mockReset()
    mockConnectionManager.getState.mockReset()
    mockConnectionManager.disconnectAll.mockReset()
    mockConnectionManager.setCallbacks.mockReset()
    mockConnectionManager.callbacksRef.current = null
    mockForceStopRelayForTarget.mockReset().mockResolvedValue(undefined)
    mockAcceptSshPtyOutputData.mockReset().mockResolvedValue({})
    mockAcceptSshPtyOutputExit.mockReset().mockResolvedValue(undefined)

    mockDeployAndLaunchRelay.mockReset().mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64',
      serverBuildId: relayBuildId
    })
    mockMux.dispose.mockReset()
    mockMux.isDisposed.mockReset().mockReturnValue(false)
    mockMux.onNotification.mockReset()
    mockMux.onNotificationByMethod.mockReset().mockReturnValue(() => {})
    mockMux.onDispose.mockReset().mockReturnValue(() => {})
    mockMux.request.mockReset().mockImplementation((method: string) =>
      Promise.resolve(
        method === 'pty.openClient'
          ? {
              protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
              serverBuildId: relayBuildId,
              clientGeneration: 1,
              role: 'session-owner',
              ownerGeneration: 1,
              ownerLease: 'ipc-test-owner',
              capabilities: {
                outputFlowControl: { version: 1, windowSu: DEFAULT_PTY_SOURCE_WINDOW_SU }
              }
            }
          : {}
      )
    )
    mockMux.probeLiveness.mockReset().mockResolvedValue(false)
    mockPtyProvider.onData.mockReset()
    mockPtyProvider.onExit.mockReset()
    mockPtyProvider.onReplay.mockReset()
    mockPtyProvider.attachForReconnect.mockReset().mockResolvedValue({})
    mockPtyProvider.shutdown.mockReset()
    mockPtyProvider.providerGeneration = 0
    mockRegisterSshGitProvider.mockReset()
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
    expect(channels).toContain('ssh:listConfigHosts')
    expect(channels).toContain('ssh:resolveConfigHost')
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
    expect(result).toEqual({ target: withId, repoReadoptions: [] })
  })

  it('ssh:addTarget returns exact re-adoption evidence and refreshes repos', async () => {
    const target = {
      id: 'ssh-new',
      label: 'Server',
      host: 'server.example.com',
      port: 22,
      username: 'deploy'
    }
    const repoReadoptions = [
      { oldTargetId: 'ssh-old', newTargetId: 'ssh-new', repoIds: ['repo-1'] }
    ]
    mockSshStore.addTarget.mockReturnValue(target)
    mockSshStore.lastRepoReadoptions = repoReadoptions

    const result = await handlers.get('ssh:addTarget')!(null, { target })

    expect(result).toEqual({ target, repoReadoptions })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
    expect(mockSshStore.lastRepoReadoptions).toEqual([])
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
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'terminated')
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(mockStore.removeSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1')
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('detaches active SSH sessions during app shutdown without terminating recovery', async () => {
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
    mockMux.dispose.mockClear()
    mockConnectionManager.disconnectAll.mockClear().mockResolvedValue(undefined)

    await detachAllSshSessionsForShutdown()

    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    expect(mockMux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'detached')
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(mockConnectionManager.disconnectAll).toHaveBeenCalled()
  })

  it('refuses the replacement session a paused connect would publish after shutdown began', async () => {
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
    mockConnectionManager.disconnectAll.mockResolvedValue(undefined)
    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    // Why here: the old session's lease flush is the one window where doConnect resumes straight into
    // publishing its replacement session without re-checking authority.
    let releaseDetach = (): void => {}
    const detachFlush = new Promise<void>((resolve) => {
      releaseDetach = resolve
    })
    let signalEnteredDetach = (): void => {}
    const enteredDetach = new Promise<void>((resolve) => {
      signalEnteredDetach = resolve
    })
    mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce(() => {
      signalEnteredDetach()
      return detachFlush
    })

    const replacement = handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    // Why await the flush entry and not ticks: shutdown must not snapshot what to drain until the
    // replacement connect is parked in the lease flush.
    await enteredDetach
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'detached')

    mockConnectionManager.disconnectAll.mockClear()
    // Why latch the gate here: the committed quit path owns it, so the drain alone must not fence.
    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const shutdown = detachAllSshSessionsForShutdown()
    releaseDetach()

    await expect(replacement).rejects.toThrow('closed for app shutdown')
    await shutdown

    // Why one detach: the fence sits at the publication point, so the resumed connect never registers a
    // replacement session — only the old session it had already torn down was detached.
    const detaches = mockStore.markSshRemotePtyLeasesAsync.mock.calls.filter(
      (call) => call[1] === 'detached'
    )
    expect(detaches).toHaveLength(1)
    // Why twice: once for the drain's snapshot, once after joining the connect that was still in flight.
    expect(mockConnectionManager.disconnectAll).toHaveBeenCalledTimes(2)
    expect(getActiveMultiplexer('ssh-1')).toBeUndefined()
    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'closed for app shutdown'
    )
  })

  it('joins an in-flight test-connection probe before the final shutdown disconnect', async () => {
    const target: SshTarget = {
      id: 'ssh-probe',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-probe',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    mockConnectionManager.disconnectAll.mockResolvedValue(undefined)
    mockConnectionManager.disconnect.mockClear().mockResolvedValue(undefined)

    // Why: a probe holds a transport no session owns, so shutdown has to wait for it to hand it back.
    const probeState = {
      targetId: 'ssh-probe',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    }
    let openProbeTransport = (): void => {}
    mockConnectionManager.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          openProbeTransport = () => resolve({ getState: () => probeState })
        })
    )
    const probe = handlers.get('ssh:testConnection')!(null, { targetId: 'ssh-probe' })
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
    }
    expect(mockConnectionManager.connect).toHaveBeenCalledWith(target)

    quitTeardownStartGate.tryStart({ preventDefault() {} })
    const shutdown = detachAllSshSessionsForShutdown()
    openProbeTransport()
    await shutdown

    expect(await probe).toMatchObject({ success: true })
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-probe')
  })

  it('ssh:importConfig returns imported targets', async () => {
    const imported: SshTarget[] = [
      { id: 'ssh-imp', label: 'staging', host: 'staging.com', port: 22, username: '' }
    ]
    mockSshStore.importFromSshConfig.mockReturnValue(imported)

    const result = await handlers.get('ssh:importConfig')!(null, {})
    expect(result).toEqual({ targets: imported, repoReadoptions: [] })
  })

  it('ssh:listConfigHosts loads summaries against current targets', async () => {
    mockSshStore.listTargets.mockReturnValue([
      { id: 'ssh-1', label: 'other', host: 'other.com', port: 22, username: 'x' }
    ])

    const result = await handlers.get('ssh:listConfigHosts')!(null, { query: 'oth' })

    expect(mockSshStore.listTargets).toHaveBeenCalled()
    expect(mockListConfigHosts).toHaveBeenCalledWith(mockSshStore.listTargets(), 'oth', [], {
      refresh: false
    })
    expect(result).toMatchObject({ hosts: [], hasMore: false })
  })

  // Only a picker (re)open re-reads ~/.ssh/config; filter keystrokes reuse the parse.
  it('ssh:listConfigHosts refreshes the parsed config only when asked', async () => {
    mockSshStore.listTargets.mockReturnValue([])

    await handlers.get('ssh:listConfigHosts')!(null, { query: '', refresh: true })

    expect(mockListConfigHosts).toHaveBeenCalledWith([], '', [], { refresh: true })
  })

  it('ssh:resolveConfigHost resolves only the selected alias', async () => {
    await handlers.get('ssh:resolveConfigHost')!(null, { alias: 'prod' })

    expect(mockResolveConfigHost).toHaveBeenCalledWith('prod')
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

  it('registers the provider before broadcasting connected authority', async () => {
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

    const connectedIndex = mockWindow.webContents.send.mock.calls.findIndex(
      ([channel, payload]) =>
        channel === 'ssh:state-changed' &&
        (payload as { state: SshConnectionState }).state.status === 'connected'
    )
    expect(connectedIndex).toBeGreaterThanOrEqual(0)
    expect(mockRegisterSshGitProvider.mock.invocationCallOrder[0]).toBeLessThan(
      mockWindow.webContents.send.mock.invocationCallOrder[connectedIndex]
    )
    expect(mockWindow.webContents.send.mock.calls[connectedIndex]?.[1]).toEqual({
      targetId: 'ssh-1',
      state: expect.objectContaining({
        targetId: 'ssh-1',
        status: 'connected',
        providerEpoch: expect.any(String),
        connectionGeneration: 1
      })
    })
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
      serverBuildId: relayBuildId,
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
      providerEpoch: expect.any(String),
      connectionGeneration: 1,
      remotePlatform: 'win32'
    })
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
      targetId: 'ssh-1',
      state: {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 1,
        supportsFolderDownload: true,
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

      const reconnectingState = handlers.get('ssh:getState')!(null, {
        targetId: 'ssh-1'
      }) as SshConnectionState
      expect(reconnectingState).toEqual({
        targetId: 'ssh-1',
        status: 'reconnecting',
        error: 'Relay channel lost. Reconnecting...',
        reconnectAttempt: 1,
        providerEpoch: expect.any(String),
        connectionGeneration: 2
      })
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
        targetId: 'ssh-1',
        state: reconnectingState
      })

      await vi.advanceTimersByTimeAsync(500)

      const connectedState = handlers.get('ssh:getState')!(null, {
        targetId: 'ssh-1'
      }) as SshConnectionState
      expect(connectedState).toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: reconnectingState.providerEpoch,
        connectionGeneration: reconnectingState.connectionGeneration
      })
      expect(mockWindow.webContents.send).toHaveBeenCalledWith('ssh:state-changed', {
        targetId: 'ssh-1',
        state: {
          ...connectedState,
          supportsFolderDownload: true
        }
      })
      expect(() => assertSshMutationExpectation('ssh-1', 'ssh-1', 1)).toThrow(
        'SSH connection changed; refresh and try again'
      )
      expect(() => assertSshMutationExpectation('ssh-1', 'ssh-1', 2)).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a staged mutation after the underlying SSH transport reconnects', async () => {
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
    const stagedGeneration = 1
    const callbacks = mockConnectionManager.callbacksRef.current as {
      onStateChange: (targetId: string, state: SshConnectionState) => void
    }

    callbacks.onStateChange('ssh-1', {
      targetId: 'ssh-1',
      status: 'reconnecting',
      error: null,
      reconnectAttempt: 1
    })
    callbacks.onStateChange('ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    callbacks.onStateChange('ssh-1', {
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
      targetId: 'ssh-1',
      status: 'reconnecting',
      error: 'Relay channel reconnecting...',
      reconnectAttempt: 0,
      providerEpoch: expect.any(String),
      connectionGeneration: 2
    })
    expect(() => assertSshMutationExpectation('ssh-1', 'ssh-1', stagedGeneration)).toThrow(
      'SSH connection changed; refresh and try again'
    )
    expect(() => assertSshMutationExpectation('ssh-1', 'ssh-1', 2)).not.toThrow()
  })

  // Why: reproduces the "Infinite reconnect bug" — when the raw SSH transport
  // connects but relay deploy fails permanently (dev build missing the platform
  // relay package), doConnect must not leak the transport's premature 'connected'
  // to the renderer. The renderer treats 'connected' as "session fully up" and
  // remounts SSH panes (-> window.api.ssh.connect); a premature 'connected' on
  // every failing attempt drives an unbounded reconnect loop.
  it('does not broadcast a premature connected when relay deploy fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = {}
    mockSshStore.getTarget.mockReturnValue(target)
    // Why: mirror the real SshConnection — connect() drives the raw transport to
    // 'connected' via onStateChange BEFORE the relay session establishes. The await
    // yields a microtask so this lands after connectTarget records connectInFlight,
    // matching the real ssh2 'ready' event (which fires async, post connect() call).
    mockConnectionManager.connect.mockImplementation(async () => {
      await Promise.resolve()
      const callbacks = mockConnectionManager.callbacksRef.current as {
        onStateChange: (targetId: string, state: SshConnectionState) => void
      }
      callbacks.onStateChange('ssh-1', {
        targetId: 'ssh-1',
        status: 'connecting',
        error: null,
        reconnectAttempt: 0
      })
      callbacks.onStateChange('ssh-1', {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        supportsFolderDownload: true
      })
      return conn
    })
    mockConnectionManager.getConnection.mockReturnValue(conn)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    mockDeployAndLaunchRelay
      .mockReset()
      .mockRejectedValue(
        new Error(
          'Relay package for linux-x64 not found locally. ' +
            'This may be a packaging issue — try reinstalling Orca.'
        )
      )

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'not found locally'
    )

    // Main performs exactly one connect + one disconnect per IPC (no main-side loop).
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1')

    // The renderer must never see 'connected' for a connect whose relay never
    // became ready — doConnect broadcasts the authoritative 'connected' only after
    // establish() succeeds, which it does not here.
    const connectedBroadcasts = mockWindow.webContents.send.mock.calls.filter(
      ([channel, payload]) =>
        channel === 'ssh:state-changed' &&
        (payload as { state?: SshConnectionState }).state?.status === 'connected'
    )
    expect(connectedBroadcasts).toEqual([])
  })

  // Why: guards the fix's scope. A relay version mismatch during a relay reconnect
  // strands the session 'idle' in activeSessions (only doConnect deletes it). A later
  // transport blip then delivers a raw 'connected' with NO connect in flight — the
  // 'deploying-relay' hold must NOT fire there (it would wedge the UI on an eternal
  // spinner with every reconnect/reset control disabled). The hold is gated to live
  // connects via connectInFlight.
  it('does not hold a stray connected as deploying-relay when no connect is in flight', async () => {
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
      // Establish a ready relay session, then lose the relay and fail the reconnect with
      // a version mismatch so the session is left stranded 'idle' in activeSessions.
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
      mockDeployAndLaunchRelay
        .mockReset()
        .mockRejectedValue(new RelayVersionMismatchError('2.0.0', '1.0.0'))
      getLatestRelayDisposeCallback()('connection_lost')
      await vi.advanceTimersByTimeAsync(relayReconnectDelaysMs[0])

      // The terminal relay error is surfaced; the session is now stranded 'idle'.
      expect(
        (handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' }) as SshConnectionState).status
      ).toBe('error')

      const callbacks = mockConnectionManager.callbacksRef.current as {
        onStateChange: (targetId: string, state: SshConnectionState) => void
      }
      mockWindow.webContents.send.mockClear()
      // A transport blip on the still-live SSH socket auto-recovers to 'connected' with
      // no ssh:connect in flight (connectInFlight is empty).
      callbacks.onStateChange('ssh-1', {
        targetId: 'ssh-1',
        status: 'reconnecting',
        error: null,
        reconnectAttempt: 0
      })
      callbacks.onStateChange('ssh-1', {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })

      // The stray 'connected' is forwarded as-is — never wedged at 'deploying-relay'.
      const stateChanges = mockWindow.webContents.send.mock.calls.filter(
        ([channel]) => channel === 'ssh:state-changed'
      )
      const lastStateChange = stateChanges.at(-1)
      expect(lastStateChange).toBeDefined()
      expect((lastStateChange![1] as { state: SshConnectionState }).state.status).toBe('connected')
      const heldAsDeploying = stateChanges.some(
        ([, payload]) =>
          (payload as { state?: SshConnectionState }).state?.status === 'deploying-relay'
      )
      expect(heldAsDeploying).toBe(false)
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
        reconnectAttempt: 1,
        providerEpoch: expect.any(String),
        connectionGeneration: 2
      })

      mockDeployAndLaunchRelay.mockClear()
      mockPortForwardManager.removeAllForwards.mockClear()

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 3
      })

      expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
      expect(mockDeployAndLaunchRelay).toHaveBeenCalled()
      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 3
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

      for (const [index, delayMs] of relayReconnectDelaysMs.entries()) {
        useSlowRelayLaunchOnce(relayLostStabilizedMs + 1)
        getLatestRelayDisposeCallback()('connection_lost')
        await vi.advanceTimersByTimeAsync(delayMs + relayLostStabilizedMs + 1)
        expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
          targetId: 'ssh-1',
          status: 'connected',
          error: null,
          reconnectAttempt: 0,
          providerEpoch: expect.any(String),
          connectionGeneration: index + 2
        })
      }

      getLatestRelayDisposeCallback()('connection_lost')

      expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
        targetId: 'ssh-1',
        status: 'error',
        error: 'Relay channel kept dropping. Click Reconnect on the SSH target before retrying.',
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: relayReconnectDelaysMs.length + 2
      })
    } finally {
      vi.useRealTimers()
    }
  })

  describe('relay loss while the SSH transport is down', () => {
    const relayLostTarget: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const transportState = (status: SshConnectionStatus): SshConnectionState => ({
      targetId: 'ssh-1',
      status,
      error: null,
      reconnectAttempt: 0
    })
    const setTransportStatus = (status: SshConnectionStatus): void => {
      mockConnectionManager.getState.mockReturnValue(transportState(status))
    }
    const maxRelayDelayMs = relayReconnectDelaysMs.at(-1)!
    const connectWithLiveTransport = async (): Promise<void> => {
      mockSshStore.getTarget.mockReturnValue(relayLostTarget)
      mockConnectionManager.connect.mockResolvedValue({})
      mockConnectionManager.getConnection.mockReturnValue({})
      setTransportStatus('connected')
      await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
      mockDeployAndLaunchRelay.mockClear()
    }

    it('does not consume attempts or publish the manual-reconnect banner', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        await connectWithLiveTransport()
        setTransportStatus('reconnecting')
        getLatestRelayDisposeCallback()('connection_lost')

        // Well past the whole 6-step ladder: a redeploy cannot ride a dead transport, so nothing is spent.
        const fullLadderMs = relayReconnectDelaysMs.reduce((sum, delay) => sum + delay, 0)
        await vi.advanceTimersByTimeAsync(fullLadderMs + relayLostStabilizedMs)

        expect(mockDeployAndLaunchRelay).not.toHaveBeenCalled()
        expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual({
          targetId: 'ssh-1',
          status: 'reconnecting',
          error: 'Relay channel lost. Reconnecting...',
          reconnectAttempt: 0,
          providerEpoch: expect.any(String),
          connectionGeneration: 2
        })

        setTransportStatus('connected')
        await vi.advanceTimersByTimeAsync(maxRelayDelayMs)
        expect(mockDeployAndLaunchRelay).toHaveBeenCalledTimes(1)
        expect(
          (handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' }) as SshConnectionState).status
        ).toBe('connected')
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops retrying once the transport reaches a terminal state', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        await connectWithLiveTransport()
        setTransportStatus('reconnecting')
        getLatestRelayDisposeCallback()('connection_lost')
        await vi.advanceTimersByTimeAsync(maxRelayDelayMs)

        setTransportStatus('reconnection-failed')
        await vi.advanceTimersByTimeAsync(maxRelayDelayMs)

        // The wait loop is gone: only onStateChange's redeploy may revive the relay after this.
        setTransportStatus('connected')
        await vi.advanceTimersByTimeAsync(maxRelayDelayMs * 4)
        expect(mockDeployAndLaunchRelay).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('resets the relay budget when the connection disappears before retry', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        await connectWithLiveTransport()
        getLatestRelayDisposeCallback()('connection_lost')

        mockConnectionManager.getConnection.mockReturnValue(undefined)
        await vi.advanceTimersByTimeAsync(relayReconnectDelaysMs[0])

        mockConnectionManager.getConnection.mockReturnValue({})
        getLatestRelayDisposeCallback()('connection_lost')
        expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toEqual(
          expect.objectContaining({ reconnectAttempt: 1 })
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('still reaches the manual-reconnect banner when the transport is healthy', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        await connectWithLiveTransport()
        mockDeployAndLaunchRelay.mockRejectedValue(new Error('relay refused'))
        getLatestRelayDisposeCallback()('connection_lost')
        for (const delayMs of relayReconnectDelaysMs) {
          await vi.advanceTimersByTimeAsync(delayMs)
        }

        expect(
          (handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' }) as SshConnectionState).error
        ).toBe('Relay channel kept dropping. Click Reconnect on the SSH target before retrying.')
      } finally {
        vi.useRealTimers()
      }
    })

    it('restores the full relay budget once the transport reconnects', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      try {
        await connectWithLiveTransport()
        mockDeployAndLaunchRelay.mockRejectedValue(new Error('relay refused'))
        getLatestRelayDisposeCallback()('connection_lost')
        await vi.advanceTimersByTimeAsync(relayReconnectDelaysMs[0])

        const callbacks = mockConnectionManager.callbacksRef.current as {
          onStateChange: (targetId: string, state: SshConnectionState) => void
        }
        callbacks.onStateChange('ssh-1', transportState('reconnecting'))
        callbacks.onStateChange('ssh-1', transportState('connected'))
        await vi.advanceTimersByTimeAsync(0)

        // Budget reset: the next loss waits the base delay again instead of the third ladder step.
        mockDeployAndLaunchRelay.mockClear()
        await vi.advanceTimersByTimeAsync(relayReconnectDelaysMs[0])
        expect(mockDeployAndLaunchRelay).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })
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
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 2
      })

      await vi.advanceTimersByTimeAsync(relayLostStabilizedMs + 1)
      mockDeployAndLaunchRelay.mockClear()
      mockPortForwardManager.removeAllForwards.mockClear()

      await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual({
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 2
      })
      expect(mockPortForwardManager.removeAllForwards).not.toHaveBeenCalled()
      expect(mockDeployAndLaunchRelay).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards remote PTY events through the output intake authority', async () => {
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
    const onData = mockPtyProvider.onData.mock.calls[0]?.[0] as SshPtyDataCallback | undefined
    const onExit = mockPtyProvider.onExit.mock.calls[0]?.[0] as
      | ((payload: {
          id: string
          code: number
          providerGeneration: number
          ptyIncarnation: string
        }) => void)
      | undefined

    onData?.({
      id: 'remote-pty',
      data: 'hello',
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty',
      source: ipcTestSource
    })
    onExit?.({
      id: 'remote-pty',
      code: 7,
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty'
    })

    expect(mockAcceptSshPtyOutputData).toHaveBeenCalledWith({
      id: 'remote-pty',
      data: 'hello',
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty',
      rawLength: 'hello'.length,
      transformed: false,
      source: ipcTestSource
    })
    expect(mockAcceptSshPtyOutputExit).toHaveBeenCalledWith({
      id: 'remote-pty',
      code: 7,
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty'
    })
    expect(runtime.onPtyData).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
  })

  it('mirrors SSH state broadcasts onto the runtime client-event stream', async () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      notifySshStateChanged: vi.fn(),
      notifySshRelayReady: vi.fn()
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

    // Why: paired remote clients only learn SSH state through this hook —
    // without it their reconnect overlays never clear (STA-1468).
    expect(runtime.notifySshStateChanged).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({ targetId: 'ssh-1', status: 'connected' })
    )
    expect(runtime.notifySshRelayReady).toHaveBeenCalledWith('ssh-1')
  })

  it('keeps runtime-owned SSH state off the renderer while invalidating runtime scans', async () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      invalidateSshWorktreeScanCache: vi.fn(),
      notifySshStateChanged: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    mockSshStore.getTarget.mockReturnValue({
      id: 'runtime-ssh-1',
      label: 'Runtime host',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    } satisfies SshTarget)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'runtime-ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'runtime-ssh-1' })

    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.anything()
    )
    expect(runtime.invalidateSshWorktreeScanCache).toHaveBeenCalledWith('runtime-ssh-1')
    expect(runtime.notifySshStateChanged).not.toHaveBeenCalled()
  })

  it('invalidates runtime scans from hidden SSH state broadcasts', () => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      invalidateSshWorktreeScanCache: vi.fn(),
      notifySshStateChanged: vi.fn()
    }
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    const callbacks = mockConnectionManager.callbacksRef.current as {
      onStateChange: (targetId: string, state: SshConnectionState) => void
    }

    callbacks.onStateChange('runtime-ssh-1', {
      targetId: 'runtime-ssh-1',
      status: 'disconnected',
      error: null,
      reconnectAttempt: 1
    })

    expect(runtime.invalidateSshWorktreeScanCache).toHaveBeenCalledWith('runtime-ssh-1')
    expect(runtime.notifySshStateChanged).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.anything()
    )
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

    await expect(handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })).resolves.toEqual({
      ...connectedState,
      providerEpoch: expect.any(String),
      connectionGeneration: 1
    })
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

  it('refreshes live session callbacks to the newest window and output authorities', async () => {
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
    const onData = mockPtyProvider.onData.mock.calls[0]?.[0] as SshPtyDataCallback | undefined
    const onExit = mockPtyProvider.onExit.mock.calls[0]?.[0] as
      | ((payload: {
          id: string
          code: number
          providerGeneration: number
          ptyIncarnation: string
        }) => void)
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
    onData?.({
      id: 'remote-pty',
      data: 'hello',
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty',
      source: ipcTestSource
    })
    onExit?.({
      id: 'remote-pty',
      code: 9,
      providerGeneration: mockPtyProvider.providerGeneration,
      ptyIncarnation: 'ipc-test-pty'
    })
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
        reconnectAttempt: 0,
        providerEpoch: expect.any(String),
        connectionGeneration: 1
      }
    })
    expect(mockAcceptSshPtyOutputData).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-pty', data: 'hello' })
    )
    expect(mockAcceptSshPtyOutputExit).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'remote-pty', code: 9 })
    )
    expect(secondWindow.webContents.send).toHaveBeenCalledWith('ssh:detected-ports-changed', {
      targetId: 'ssh-1',
      ports: expect.arrayContaining([expect.objectContaining({ port: 3000 })])
    })
    expect(secondRuntime.onPtyData).not.toHaveBeenCalled()
    expect(secondRuntime.onPtyExit).not.toHaveBeenCalled()
    expect(firstRuntime.onPtyData).not.toHaveBeenCalled()
    expect(firstRuntime.onPtyExit).not.toHaveBeenCalled()
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

  it('lets a same-turn disconnect invalidate connect before transport admission', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.disconnect.mockResolvedValue(undefined)

    const connect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    const disconnect = handlers.get('ssh:disconnect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>

    await disconnect
    await expect(connect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
  })

  it('invalidates a pending connect when disconnect wins and allows a fresh connect', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const staleConn = {}
    const freshConn = {}
    let resolveStaleConnect!: (connection: unknown) => void
    let resolveForwardRemoval!: () => void
    let transportConnectPending = false
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect
      .mockReturnValueOnce(
        new Promise((resolve) => {
          transportConnectPending = true
          resolveStaleConnect = resolve
        })
      )
      .mockImplementationOnce(async () => {
        if (transportConnectPending) {
          throw new Error('Connection to Server is already in progress')
        }
        return freshConn
      })
    mockConnectionManager.disconnect.mockImplementationOnce(async () => {
      transportConnectPending = false
    })
    mockPortForwardManager.removeAllForwards.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveForwardRemoval = resolve
        })
    )
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    const staleConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1))

    const disconnect = handlers.get('ssh:disconnect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    await vi.waitFor(() => expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1'))
    const freshConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    resolveStaleConnect(staleConn)
    await expect(staleConnect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    resolveForwardRemoval()
    await disconnect
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(2))

    await expect(freshConnect).resolves.toMatchObject({ targetId: 'ssh-1', status: 'connected' })
    expect(mockDeployAndLaunchRelay).toHaveBeenCalledTimes(1)
  })

  it('closes the transport a cancelled connect opened after the disconnect finished', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const lateConn = { id: 'late-transport' }
    let resolveStaleConnect!: (connection: unknown) => void
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleConnect = resolve
      })
    )
    mockConnectionManager.disconnect.mockResolvedValue(undefined)

    const staleConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1))
    // Why await the whole disconnect: the leak only exists once its teardown has already run, so
    // nothing else is left to close the transport this attempt opens afterwards.
    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })

    resolveStaleConnect(lateConn)

    await expect(staleConnect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', lateConn)
    expect(getActiveMultiplexer('ssh-1')).toBeUndefined()
  })

  it('closes the transport when establish resumes after the connect was invalidated', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    const conn = { id: 'establishing-transport' }
    let releaseRelayLaunch = (): void => {}
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(undefined)
    mockConnectionManager.connect.mockResolvedValue(conn)
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    mockDeployAndLaunchRelay.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRelayLaunch = () => resolve(createRelayLaunchResult())
        })
    )

    const connect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    await vi.waitFor(() => expect(mockDeployAndLaunchRelay).toHaveBeenCalledTimes(1))
    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })

    releaseRelayLaunch()

    await expect(connect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).toHaveBeenCalledWith('ssh-1', conn)
    expect(getActiveMultiplexer('ssh-1')).toBeUndefined()
  })

  it('leaves a reused transport to its replacement when the connect is cancelled', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    // Why: connect() hands back the already-open transport, so this attempt never owned it.
    const sharedConn = { id: 'shared-transport' }
    let resolveStaleConnect!: (connection: unknown) => void
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue(sharedConn)
    mockConnectionManager.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStaleConnect = resolve
      })
    )
    mockConnectionManager.disconnect.mockResolvedValue(undefined)

    const staleConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1))
    await handlers.get('ssh:disconnect')!(null, { targetId: 'ssh-1' })

    resolveStaleConnect(sharedConn)

    await expect(staleConnect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(mockConnectionManager.disconnectConnection).not.toHaveBeenCalled()
  })

  it('keeps reconnect behind transport disconnect when forward teardown fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let resolveTransportDisconnect!: () => void
    let transportDisconnectPending = false
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValueOnce({}).mockImplementationOnce(async () => {
      if (transportDisconnectPending) {
        throw new Error('Connection to Server is already in progress')
      }
      return {}
    })
    mockConnectionManager.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          transportDisconnectPending = true
          resolveTransportDisconnect = () => {
            transportDisconnectPending = false
            resolve()
          }
        })
    )
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockPortForwardManager.removeAllForwards.mockRejectedValueOnce(
      new Error('forward teardown failed')
    )

    const disconnect = handlers.get('ssh:disconnect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    const disconnectSettled = vi.fn()
    void disconnect.then(disconnectSettled, disconnectSettled)
    await vi.waitFor(() =>
      expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    )
    const reconnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    const reconnectResult = reconnect.then(
      (state) => ({ ok: true as const, state }),
      (error: unknown) => ({ ok: false as const, error })
    )
    await Promise.resolve()

    expect(disconnectSettled).not.toHaveBeenCalled()
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    resolveTransportDisconnect()

    await expect(disconnect).rejects.toThrow('forward teardown failed')
    await expect(reconnectResult).resolves.toMatchObject({
      ok: true,
      state: { targetId: 'ssh-1', status: 'connected' }
    })
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(2)
    expect(mockMux.dispose).toHaveBeenCalledWith('connection_lost')
  })

  it('retires a removed target session after forward teardown fails', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let resolveTransportDisconnect!: () => void
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockResolvedValue({})
    mockConnectionManager.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveTransportDisconnect = resolve
        })
    )
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    mockPortForwardManager.removeAllForwards.mockRejectedValueOnce(
      new Error('forward teardown failed')
    )

    const removal = handlers.get('ssh:removeTarget')!(null, {
      id: 'ssh-1'
    }) as Promise<void>
    await vi.waitFor(() =>
      expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    )
    await Promise.resolve()

    expect(mockSshStore.removeTarget).not.toHaveBeenCalled()
    resolveTransportDisconnect()
    await removal

    expect(mockMux.dispose).toHaveBeenCalledWith('shutdown')
    expect(mockStore.removeSshRemotePtyLeases).toHaveBeenCalledWith('ssh-1')
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('replaces a stale shared connect after authority rotates without disconnect', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let resolveStaleConnect!: (connection: unknown) => void
    let resolveForwardRemoval!: () => void
    let resolveTransportDisconnect!: () => void
    let transportConnectPending = false
    mockSshStore.getTarget.mockReturnValue(target)
    mockSshStore.addTarget.mockReturnValue(target)
    mockConnectionManager.connect
      .mockReturnValueOnce(
        new Promise((resolve) => {
          transportConnectPending = true
          resolveStaleConnect = resolve
        })
      )
      .mockImplementationOnce(async () => {
        if (transportConnectPending) {
          throw new Error('Connection to Server is already in progress')
        }
        return {}
      })
    mockConnectionManager.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveTransportDisconnect = () => {
            transportConnectPending = false
            resolve()
          }
        })
    )
    mockPortForwardManager.removeAllForwards.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveForwardRemoval = resolve
        })
    )
    mockConnectionManager.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })

    const staleConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    const sharedStaleConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1))

    mockSshStore.lastRepoReadoptions = [
      { oldTargetId: 'ssh-1', newTargetId: 'ssh-new', repoIds: ['repo-1'] }
    ]
    await handlers.get('ssh:addTarget')!(null, { target })
    const freshConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    await vi.waitFor(() =>
      expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledWith('ssh-1')
    )
    await vi.waitFor(() => expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1'))
    const sharedFreshConnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    resolveForwardRemoval()
    resolveTransportDisconnect()
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(2))

    resolveStaleConnect({})

    await expect(staleConnect).rejects.toThrow('SSH connection attempt was cancelled')
    await expect(sharedStaleConnect).rejects.toThrow('SSH connection attempt was cancelled')
    await expect(freshConnect).resolves.toMatchObject({ targetId: 'ssh-1', status: 'connected' })
    await expect(sharedFreshConnect).resolves.toMatchObject({
      targetId: 'ssh-1',
      status: 'connected'
    })
    expect(mockDeployAndLaunchRelay).toHaveBeenCalledTimes(1)
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

  it('keeps reconnect behind the complete terminate-sessions lifecycle', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let resolveShutdown!: () => void
    let resolveForwardRemoval!: () => void
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
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    mockPtyProvider.shutdown.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveShutdown = resolve
      })
    )
    mockPortForwardManager.removeAllForwards.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveForwardRemoval = resolve
        })
    )

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })
    const terminate = handlers.get('ssh:terminateSessions')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    await vi.waitFor(() => expect(mockPtyProvider.shutdown).toHaveBeenCalledOnce())
    const reconnect = handlers.get('ssh:connect')!(null, {
      targetId: 'ssh-1'
    }) as Promise<SshConnectionState>
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)

    resolveShutdown()
    await vi.waitFor(() => expect(mockConnectionManager.disconnect).toHaveBeenCalledWith('ssh-1'))
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    resolveForwardRemoval()
    await terminate
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(2))

    await expect(reconnect).resolves.toMatchObject({ targetId: 'ssh-1', status: 'connected' })
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

  it('retires the captured session when reset forward teardown fails', async () => {
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
    mockPortForwardManager.removeAllForwards.mockRejectedValueOnce(
      new Error('forward teardown failed')
    )

    await expect(handlers.get('ssh:resetRelay')!(null, { targetId: 'ssh-1' })).rejects.toThrow(
      'forward teardown failed'
    )
    expect(mockMux.dispose).toHaveBeenCalledWith('connection_lost')
    expect(mockForceStopRelayForTarget).not.toHaveBeenCalled()

    await handlers.get('ssh:resetRelay')!(null, { targetId: 'ssh-1' })

    expect(mockPortForwardManager.removeAllForwards).toHaveBeenCalledTimes(1)
    expect(mockForceStopRelayForTarget).toHaveBeenCalledWith(conn, 'ssh-1')
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

  it('ssh:resetRelay does not open a transport when shutdown starts while it waits for a connect', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let failConnect!: (error: unknown) => void
    const connectResult = new Promise((_resolve, reject) => {
      failConnect = reject
    })
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.connect.mockReturnValue(connectResult)
    // Why undefined: reset must fall through to opening its own transport, which is the call under test.
    mockConnectionManager.getConnection.mockReturnValue(undefined)
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

    // Why admitted first: the gate latches only after reset is already parked behind the connect, so
    // the entry fence cannot be what stops it.
    const resetPromise = handlers.get('ssh:resetRelay')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    await Promise.resolve()

    quitTeardownStartGate.tryStart({ preventDefault() {} })
    failConnect(new Error('transport lost'))
    await expect(connectPromise).rejects.toThrow('transport lost')

    await expect(resetPromise).rejects.toThrow('closed for app shutdown')
    // Why once: the resumed reset must not open a second transport that would outlive the drain.
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    expect(mockForceStopRelayForTarget).not.toHaveBeenCalled()
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

  it('keeps removal behind an in-flight relay reset', async () => {
    const target: SshTarget = {
      id: 'ssh-1',
      label: 'Server',
      host: 'example.com',
      port: 22,
      username: 'deploy'
    }
    let resolveForceStop!: () => void
    mockSshStore.getTarget.mockReturnValue(target)
    mockConnectionManager.getConnection.mockReturnValue({})
    mockConnectionManager.disconnect.mockResolvedValue(undefined)
    mockForceStopRelayForTarget.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveForceStop = resolve
      })
    )

    const reset = handlers.get('ssh:resetRelay')!(null, {
      targetId: 'ssh-1'
    }) as Promise<void>
    await vi.waitFor(() => expect(mockForceStopRelayForTarget).toHaveBeenCalledOnce())
    const removal = handlers.get('ssh:removeTarget')!(null, {
      id: 'ssh-1'
    }) as Promise<void>
    await Promise.resolve()

    expect(mockSshStore.removeTarget).not.toHaveBeenCalled()
    resolveForceStop()
    await reset
    await removal

    expect(mockConnectionManager.disconnect).toHaveBeenCalledTimes(2)
    expect(mockSshStore.removeTarget).toHaveBeenCalledWith('ssh-1')
  })

  it('reconnects on system resume when the relay liveness probe fails', async () => {
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
    mockConnectionManager.reconnect.mockImplementation(async (targetId: string) => {
      const callbacks = mockConnectionManager.callbacksRef.current as {
        onStateChange: (id: string, state: SshConnectionState) => void
      }
      callbacks.onStateChange(targetId, {
        targetId,
        status: 'reconnecting',
        error: null,
        reconnectAttempt: 1
      })
      callbacks.onStateChange(targetId, {
        targetId,
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    })
    mockMux.probeLiveness.mockResolvedValue(false)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    const resumeListener = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1]
    expect(resumeListener).toBeTypeOf('function')

    resumeListener()

    await vi.waitFor(() => expect(mockConnectionManager.reconnect).toHaveBeenCalledWith('ssh-1'))
    // Why: a failed first probe gets one retry before teardown (slow post-wake network).
    expect(mockMux.probeLiveness).toHaveBeenCalledTimes(2)
    expect(handlers.get('ssh:getState')!(null, { targetId: 'ssh-1' })).toMatchObject({
      connectionGeneration: 2
    })
  })

  it('skips reconnect on system resume when the relay link is still alive', async () => {
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
    mockMux.probeLiveness.mockResolvedValue(true)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    const resumeListener = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1]
    expect(resumeListener).toBeTypeOf('function')

    resumeListener()

    await vi.waitFor(() => expect(mockMux.probeLiveness).toHaveBeenCalledTimes(1))
    // Let the async resume handler settle before asserting no teardown happened.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockConnectionManager.reconnect).not.toHaveBeenCalled()
  })

  it('does not reconnect after resume when the target was disconnected during the probe', async () => {
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
    mockMux.probeLiveness.mockResolvedValue(false)

    await handlers.get('ssh:connect')!(null, { targetId: 'ssh-1' })

    const resumeListener = powerMonitorOnMock.mock.calls.find(([event]) => event === 'resume')?.[1]
    expect(resumeListener).toBeTypeOf('function')

    resumeListener()
    // Why: the probe window is seconds long; a user disconnect during it must
    // win — reconnecting afterwards would resurrect the torn-down target.
    mockConnectionManager.getConnection.mockReturnValue(undefined)

    await vi.waitFor(() => expect(mockMux.probeLiveness).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockConnectionManager.reconnect).not.toHaveBeenCalled()
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
    mockStore.markSshRemotePtyLeasesAsync.mockClear()
    mockStore.markSshRemotePtyLease.mockClear()
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: 'ssh-1', ptyId: 'pty-1', state: 'attached' }
    ])

    await handlers.get('ssh:resetRelay')!(null, { targetId: 'ssh-1' })

    expect(mockStore.markSshRemotePtyLeasesAsync).not.toHaveBeenCalledWith('ssh-1', 'terminated')
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith('ssh-1', 'detached')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('ssh-1', 'pty-1', 'expired')
    expect(mockForceStopRelayForTarget).toHaveBeenCalledWith(conn, 'ssh-1')
  })

  describe('SSH PTY consumer identity across failed connects', () => {
    function makeTarget(id: string): SshTarget {
      return { id, label: 'Server', host: 'example.com', port: 22, username: 'deploy' }
    }

    function markConnected(targetId: string): void {
      mockConnectionManager.getState.mockReturnValue({
        targetId,
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })
    }

    it('reclaims the consumer identity after a failed transport connect', async () => {
      const targetId = 'ssh-consumer-identity-connect-failure'
      let settleLeasePersistence!: () => void
      mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleLeasePersistence = resolve
          })
      )
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockRejectedValueOnce(new Error('transport refused'))

      const failedConnect = handlers.get('ssh:connect')!(null, { targetId }) as Promise<unknown>
      const failure = expect(failedConnect).rejects.toThrow('transport refused')
      const settled = vi.fn()
      void failedConnect.then(settled, settled)

      await vi.waitFor(() =>
        expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith(targetId, 'detached')
      )
      expect(mockStore.markSshRemotePtyLeases).not.toHaveBeenCalled()
      // Why: the connect rejection is gated on the durable 'detached' write, so the retry it
      // triggers cannot re-mark leases 'attached' ahead of the abandoned session's release.
      expect(settled).not.toHaveBeenCalled()

      settleLeasePersistence()
      await failure
      const claimedId = getSshPtyConsumerRecovery(targetId)?.clientInstanceId
      expect(claimedId).toEqual(expect.any(String))

      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      await handlers.get('ssh:connect')!(null, { targetId })

      expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBe(claimedId)
      expect(mockStore.upsertSshPtyConsumerRecovery).toHaveBeenCalledWith(
        expect.objectContaining({ targetId, clientInstanceId: claimedId })
      )
    })

    it('releases the abandoned leases before a fast reconnect re-owns them', async () => {
      const targetId = 'ssh-consumer-identity-fast-reconnect'
      const order: string[] = []
      let settleLeaseRelease!: () => void
      mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce((_id: string, state: string) => {
        order.push(`leases:${state}`)
        return new Promise<void>((resolve) => {
          settleLeaseRelease = () => {
            order.push(`leases:${state}:persisted`)
            resolve()
          }
        })
      })
      mockStore.upsertSshPtyConsumerRecovery.mockImplementation(async () => {
        order.push('recovery:upsert')
      })
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockRejectedValueOnce(new Error('transport refused'))

      const failedConnect = handlers.get('ssh:connect')!(null, { targetId })
      const failure = expect(failedConnect).rejects.toThrow('transport refused')
      await vi.waitFor(() => expect(order).toContain('leases:detached'))
      expect(order).not.toContain('leases:detached:persisted')

      settleLeaseRelease()
      await failure

      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      await handlers.get('ssh:connect')!(null, { targetId })

      // Why: the reclaimed owner is only re-persisted after the abandoned 'detached' write landed,
      // so no late release can strand the reconnected leases in 'detached'.
      expect(order).toEqual(['leases:detached', 'leases:detached:persisted', 'recovery:upsert'])
    })

    it('holds a retry that starts while the detach write is still pending', async () => {
      const targetId = 'ssh-consumer-identity-pending-retry'
      const order: string[] = []
      let settleLeaseRelease!: () => void
      mockStore.markSshRemotePtyLeasesAsync.mockImplementationOnce((_id: string, state: string) => {
        order.push(`leases:${state}`)
        return new Promise<void>((resolve) => {
          settleLeaseRelease = () => {
            order.push(`leases:${state}:persisted`)
            resolve()
          }
        })
      })
      mockStore.upsertSshPtyConsumerRecovery.mockImplementation(async () => {
        order.push('recovery:upsert')
      })
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockRejectedValueOnce(new Error('transport refused'))

      const failedConnect = handlers.get('ssh:connect')!(null, { targetId })
      const failure = expect(failedConnect).rejects.toThrow('transport refused')
      await vi.waitFor(() => expect(order).toContain('leases:detached'))

      // Retry mid-write: it must not mint a session or re-own leases while the release is pending.
      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      const retry = handlers.get('ssh:connect')!(null, { targetId }) as Promise<unknown>
      const retrySettled = vi.fn()
      void retry.then(retrySettled, retrySettled)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(retrySettled).not.toHaveBeenCalled()
      expect(order).not.toContain('leases:detached:persisted')

      settleLeaseRelease()
      await failure
      // Why: the retry folds onto the still-latched attempt rather than starting a second connect,
      // so it inherits that attempt's failure instead of racing its teardown.
      await expect(retry).rejects.toThrow('transport refused')
      expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['leases:detached', 'leases:detached:persisted'])

      await handlers.get('ssh:connect')!(null, { targetId })

      expect(order).toEqual(['leases:detached', 'leases:detached:persisted', 'recovery:upsert'])
    })

    it('replaces a live session whose detach write keeps failing', async () => {
      const targetId = 'ssh-consumer-identity-detach-write-failure'
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      await handlers.get('ssh:connect')!(null, { targetId })
      const claimedId = getSshPtyConsumerRecovery(targetId)?.clientInstanceId
      expect(claimedId).toEqual(expect.any(String))

      // Why a permanent reject, not once: it proves the failed session is gone rather than merely
      // retried — a second connect that still holds it would fail on the same write again.
      mockStore.markSshRemotePtyLeasesAsync.mockImplementation((_id: string, state: string) =>
        state === 'detached'
          ? Promise.reject(new Error('lease write failed'))
          : Promise.resolve(undefined)
      )
      await expect(handlers.get('ssh:connect')!(null, { targetId })).rejects.toThrow(
        'lease write failed'
      )

      mockConnectionManager.connect.mockClear()
      await handlers.get('ssh:connect')!(null, { targetId })

      expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
      // Why: the abandoned session still released its identity synchronously, so the replacement
      // reclaims the owner instead of minting a new one.
      expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBe(claimedId)
    })

    it('resumes the remembered owner lease after a failed establish', async () => {
      const targetId = 'ssh-consumer-identity-establish-failure'
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockSshStore.getTarget.mockReturnValue(makeTarget(targetId))
      mockConnectionManager.connect.mockResolvedValue({})
      markConnected(targetId)
      // Why: fail the first request after the consumer session opens, so establish() rejects with an
      // owner lease already remembered — the state a retry must be able to resume from.
      const openClientResponse = await mockMux.request('pty.openClient')
      mockMux.request.mockImplementationOnce(() => Promise.resolve(openClientResponse))
      mockMux.request.mockImplementationOnce(() =>
        Promise.reject(new Error('relay handshake aborted'))
      )
      mockStore.markSshRemotePtyLeasesAsync.mockRejectedValueOnce(
        new Error('lease persistence failed')
      )

      try {
        await expect(handlers.get('ssh:connect')!(null, { targetId })).rejects.toThrow(
          'relay handshake aborted'
        )
        await vi.waitFor(() => expect(warn).toHaveBeenCalled())
        const claimedId = getSshPtyConsumerRecovery(targetId)?.clientInstanceId
        expect(claimedId).toEqual(expect.any(String))

        mockMux.request.mockClear()
        await handlers.get('ssh:connect')!(null, { targetId })

        expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBe(claimedId)
        expect(mockMux.request).toHaveBeenCalledWith(
          'pty.openClient',
          expect.objectContaining({
            clientInstanceId: claimedId,
            resume: { ownerGeneration: 1, ownerLease: 'ipc-test-owner' }
          }),
          expect.anything()
        )
      } finally {
        warn.mockRestore()
      }
    })
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
    expect(result).toEqual({
      ...state,
      providerEpoch: expect.any(String),
      connectionGeneration: 0
    })
  })
})
