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

import {
  SSH_RELAY_CONFIGURE_GRACE_TIME_METHOD,
  type SshConnectionState,
  type SshTarget
} from '../../shared/ssh-types'
import { clearProviderPtyState, deletePtyOwnership, getPtyIdsForConnection } from './pty'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  powerMonitorOnMock,
  mockSshStore,
  mockConnectionManager,
  mockForceStopRelayForTarget,
  mockMux,
  mockPortForwardManager
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore } = harness

  beforeEach(harness.reset)

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
})
