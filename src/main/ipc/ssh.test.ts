import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-relay-deploy', () => mocks.sshRelayDeploy)
vi.mock('../ssh/ssh-relay-reset', () => mocks.sshRelayReset)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { RelayVersionMismatchError } from '../ssh/ssh-relay-version-mismatch-error'
import type { SshConnectionState, SshConnectionStatus, SshTarget } from '../../shared/ssh-types'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockDeployAndLaunchRelay,
  mockMux,
  mockRegisterSshGitProvider,
  mockPortForwardManager
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const {
    relayBuildId,
    handlers,
    mockWindow,
    relayReconnectDelaysMs,
    relayLostStabilizedMs,
    getLatestRelayDisposeCallback,
    useSlowRelayLaunchOnce
  } = harness

  beforeEach(harness.reset)

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
})
