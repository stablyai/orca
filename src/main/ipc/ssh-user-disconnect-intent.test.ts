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
vi.mock('../ssh/ssh-connection', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...mocks.sshConnection
}))
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

import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import {
  SSH_DISCONNECTED_BY_USER_CODE,
  describeSshDisconnectedByUser
} from '../../shared/ssh-disconnected-by-user'
import { getSshProviderAuthority } from '../ssh/ssh-provider-authority'
import { connectRegisteredSshTarget } from '../ssh/ssh-target-registry'
import { disconnectRuntimeOwnedSshTarget } from '../ephemeral-vm-runtime-ssh'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { SSH_METHODS } from '../runtime/rpc/methods/ssh'
import { getSshPtyProvider } from './pty'
import { registerSshHandlers } from './ssh'
import { activeSessions } from './ssh-active-relay-sessions'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockMaintenanceConnection,
  mockForceStopRelayForTarget,
  mockMux,
  mockPtyProvider,
  mockPortForwardManager
} = mocks

const TARGET: SshTarget = {
  id: 'ssh-1',
  label: 'Dev box',
  host: 'example.com',
  port: 22,
  username: 'deploy'
}

const SAVED_FORWARD = { localPort: 3000, remoteHost: 'localhost', remotePort: 3000 }

// Why a map that outlives harness.reset: the persisted target row is what survives a restart.
let persistedTargets = new Map<string, SshTarget>()

function installPersistedTargetStore(): void {
  mockSshStore.getTarget.mockImplementation((id: string) => {
    const target = persistedTargets.get(id)
    return target ? { ...target } : undefined
  })
  mockSshStore.updateTarget.mockImplementation((id: string, updates: Partial<SshTarget>) => {
    const target = persistedTargets.get(id)
    if (!target) {
      return null
    }
    const updated = { ...target, ...updates }
    persistedTargets.set(id, updated)
    return { ...updated }
  })
}

function connectedState(targetId = TARGET.id): SshConnectionState {
  return { targetId, status: 'connected', error: null, reconnectAttempt: 0 }
}

function sentStates(send: ReturnType<typeof vi.fn>): SshConnectionState[] {
  return send.mock.calls
    .filter(([channel]) => channel === 'ssh:state-changed')
    .map(([, payload]) => payload.state)
}

// The connection manager's callbacks are how the transport reports a network drop.
function reportTransportState(state: SshConnectionState): void {
  const callbacks = mockConnectionManager.callbacksRef.current
  if (
    !callbacks ||
    typeof callbacks !== 'object' ||
    !('onStateChange' in callbacks) ||
    typeof callbacks.onStateChange !== 'function'
  ) {
    throw new Error('SSH connection callbacks were not installed')
  }
  callbacks.onStateChange(state.targetId, state)
}

// The maintenance connection reports through the callbacks it was constructed with.
function reportMaintenanceState(status: SshConnectionState['status']): void {
  const callbacks = mockMaintenanceConnection.callbacksRef.current
  if (
    !callbacks ||
    typeof callbacks !== 'object' ||
    !('onStateChange' in callbacks) ||
    typeof callbacks.onStateChange !== 'function'
  ) {
    throw new Error('The maintenance connection was never constructed')
  }
  callbacks.onStateChange(TARGET.id, { ...connectedState(), status })
}

describe("SSH: the user's Disconnect holds until the user connects", () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockWindow, mockStore } = harness

  const invoke = async (channel: string, targetId = TARGET.id): Promise<unknown> =>
    handlers.get(channel)!(null, { targetId })

  // A live transport exists between a successful connect and the next disconnect.
  const useLiveTransport = (): void => {
    let live: object | undefined
    mockConnectionManager.connect.mockImplementation(async () => {
      live = {}
      return live
    })
    mockConnectionManager.disconnect.mockImplementation(async () => {
      live = undefined
    })
    mockConnectionManager.getConnection.mockImplementation(() => live)
    mockConnectionManager.getState.mockImplementation(() => (live ? connectedState() : null))
  }

  // Remote sessions only a relay can reach: a lease the app owns, and a provider only while live.
  const holdSessionsThatNeedTheRelay = (): void => {
    mockStore.getSshRemotePtyLeases.mockReturnValue([
      { targetId: TARGET.id, ptyId: 'pty-1', state: 'detached' }
    ])
    vi.mocked(getSshPtyProvider).mockImplementation((targetId: string) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminate calls only shutdown, which the shared mock provider implements.
      activeSessions.has(targetId) ? (mockPtyProvider as never) : undefined
    )
    mockPtyProvider.shutdown.mockResolvedValue(undefined)
  }

  const useRuntime = (): { notifySshRelayReady: ReturnType<typeof vi.fn> } => {
    const runtime = {
      onPtyData: vi.fn(),
      onPtyExit: vi.fn(),
      notifySshStateChanged: vi.fn(),
      notifySshRelayReady: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness stubs only the store, window and runtime members the SSH handlers call.
    registerSshHandlers(mockStore as never, () => mockWindow as never, runtime as never)
    return runtime
  }

  beforeEach(async () => {
    persistedTargets = new Map([[TARGET.id, { ...TARGET, portForwards: [SAVED_FORWARD] }]])
    await harness.reset()
    installPersistedTargetStore()
    useLiveTransport()
  })

  it('(a) refuses a background connect after the user disconnects, leaving no trace', async () => {
    await invoke('ssh:connect')
    await invoke('ssh:disconnect')
    const authorityAfterDisconnect = getSshProviderAuthority(TARGET.id)
    mockConnectionManager.connect.mockClear()
    mockWindow.webContents.send.mockClear()

    const refused = invoke('ssh:ensureConnected')

    await expect(refused).rejects.toMatchObject({
      code: SSH_DISCONNECTED_BY_USER_CODE,
      message: describeSshDisconnectedByUser('Dev box')
    })
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    expect(getSshProviderAuthority(TARGET.id)).toEqual(authorityAfterDisconnect)
    expect(mockWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('(a) refuses a background connect whose Disconnect landed while it waited its turn', async () => {
    await invoke('ssh:connect')
    let releaseTerminate!: () => void
    mockConnectionManager.disconnect.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTerminate = resolve
        })
    )
    // A terminate holds the target's lifecycle queue, so the connect below parks behind it.
    const terminate = invoke('ssh:terminateSessions')
    await vi.waitFor(() => expect(mockConnectionManager.disconnect).toHaveBeenCalledTimes(1))
    const parked = invoke('ssh:ensureConnected')
    const disconnect = invoke('ssh:disconnect')
    releaseTerminate()
    await terminate
    await disconnect

    await expect(parked).rejects.toMatchObject({ code: SSH_DISCONNECTED_BY_USER_CODE })
  })

  it("(b) a user's Connect records the intent and lets background connects through again", async () => {
    await invoke('ssh:disconnect')

    await expect(invoke('ssh:connect')).resolves.toMatchObject({ status: 'connected' })

    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('connected')
    await invoke('ssh:disconnect')
    persistedTargets.set(TARGET.id, { ...TARGET, desiredConnection: 'connected' })
    mockConnectionManager.connect.mockClear()
    await expect(invoke('ssh:ensureConnected')).resolves.toMatchObject({ status: 'connected' })
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
  })

  it('(c) still refuses after a restart reloads the target from the store', async () => {
    await invoke('ssh:disconnect')

    await harness.reset()
    installPersistedTargetStore()
    useLiveTransport()

    await expect(invoke('ssh:ensureConnected')).rejects.toMatchObject({
      code: SSH_DISCONNECTED_BY_USER_CODE
    })
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    expect(await invoke('ssh:getState')).toMatchObject({
      status: 'disconnected',
      disconnectedBy: 'user'
    })
  })

  it('(d) a network drop changes no intent, and a background connect after it still dials', async () => {
    await invoke('ssh:connect')
    reportTransportState({
      targetId: TARGET.id,
      status: 'reconnecting',
      error: 'socket closed',
      reconnectAttempt: 1
    })
    reportTransportState({
      targetId: TARGET.id,
      status: 'reconnection-failed',
      error: 'gave up',
      reconnectAttempt: 6
    })
    let ladderGaveUp = true
    mockConnectionManager.getState.mockImplementation(() =>
      ladderGaveUp
        ? {
            targetId: TARGET.id,
            status: 'reconnection-failed',
            error: 'gave up',
            reconnectAttempt: 6
          }
        : connectedState()
    )

    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('connected')
    expect(sentStates(mockWindow.webContents.send).some((s) => s.disconnectedBy)).toBe(false)
    mockConnectionManager.connect.mockReset().mockImplementation(async () => {
      ladderGaveUp = false
      return {}
    })
    await expect(invoke('ssh:ensureConnected')).resolves.toMatchObject({ status: 'connected' })
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
  })

  it("(e) a Disconnect during the user's own connect wins over the connect's late completion", async () => {
    let finishTransport!: (connection: unknown) => void
    mockConnectionManager.connect.mockReturnValueOnce(
      new Promise((resolve) => {
        finishTransport = resolve
      })
    )

    const connect = invoke('ssh:connect')
    await vi.waitFor(() => expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1))
    await invoke('ssh:disconnect')
    finishTransport({})

    await expect(connect).rejects.toThrow('SSH connection attempt was cancelled')
    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('disconnected')
    await expect(invoke('ssh:ensureConnected')).rejects.toMatchObject({
      code: SSH_DISCONNECTED_BY_USER_CODE
    })
  })

  it('(f) a VM teardown records no intent, and the VM connects again afterwards', async () => {
    const vmTarget: SshTarget = {
      ...TARGET,
      id: 'runtime-ssh-vm-1',
      owner: { type: 'on-demand-runtime', runtimeId: 'vm-1' }
    }
    persistedTargets.set(vmTarget.id, vmTarget)

    await connectRegisteredSshTarget(vmTarget.id, 'background')
    await disconnectRuntimeOwnedSshTarget(vmTarget.id)

    expect(persistedTargets.get(vmTarget.id)?.desiredConnection).toBeUndefined()
    mockConnectionManager.connect.mockClear()
    await expect(connectRegisteredSshTarget(vmTarget.id, 'background')).resolves.toMatchObject({
      status: 'connected'
    })
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
  })

  it('(f) never records or enforces a Disconnect on a runtime-owned target', async () => {
    const vmTarget: SshTarget = {
      ...TARGET,
      id: 'runtime-ssh-vm-2',
      owner: { type: 'on-demand-runtime', runtimeId: 'vm-2' }
    }
    persistedTargets.set(vmTarget.id, vmTarget)

    await invoke('ssh:disconnect', vmTarget.id)

    expect(persistedTargets.get(vmTarget.id)?.desiredConnection).toBeUndefined()
    await expect(invoke('ssh:ensureConnected', vmTarget.id)).resolves.toMatchObject({
      status: 'connected'
    })
  })

  it('(g) the runtime RPC refuses with the background flag and connects without it', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ssh.* handlers read only the runtime id, which this stub provides.
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SSH_METHODS })
    const call = (params: Record<string, unknown>) =>
      dispatcher.dispatch({ id: 'req-1', authToken: 'tok', method: 'ssh.connect', params })
    await invoke('ssh:disconnect')
    mockConnectionManager.connect.mockClear()

    await expect(call({ targetId: TARGET.id, background: true })).resolves.toMatchObject({
      ok: false,
      error: {
        code: SSH_DISCONNECTED_BY_USER_CODE,
        message: describeSshDisconnectedByUser('Dev box')
      }
    })
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()

    await expect(call({ targetId: TARGET.id })).resolves.toMatchObject({
      ok: true,
      result: { state: { status: 'connected' } }
    })
    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('connected')
  })

  it('(h) publishes disconnectedBy on the Disconnect broadcast and in getState', async () => {
    await invoke('ssh:connect')
    mockWindow.webContents.send.mockClear()
    mockConnectionManager.disconnect.mockImplementationOnce(async () => {
      mockConnectionManager.getConnection.mockReturnValue(undefined)
      mockConnectionManager.getState.mockReturnValue(null)
      reportTransportState({
        targetId: TARGET.id,
        status: 'disconnected',
        error: null,
        reconnectAttempt: 0
      })
    })

    await invoke('ssh:disconnect')

    expect(sentStates(mockWindow.webContents.send)).toEqual([
      expect.objectContaining({ status: 'disconnected', disconnectedBy: 'user' })
    ])
    expect(await invoke('ssh:getState')).toMatchObject({
      status: 'disconnected',
      disconnectedBy: 'user'
    })
  })

  // The invariant the user's Disconnect rests on: nothing is registered for the host while it holds.
  const expectNothingRegistered = (): void => {
    expect(mockConnectionManager.getConnection(TARGET.id)).toBeUndefined()
    expect(activeSessions.has(TARGET.id)).toBe(false)
  }

  // The relay's pty.shutdown stays pending until the test settles it or the mux is disposed.
  const holdRelayShutdown = (): PromiseWithResolvers<unknown> => {
    const shutdown = Promise.withResolvers<unknown>()
    const request = mockMux.request.getMockImplementation()!
    mockMux.request.mockImplementation((method: string, ...rest: unknown[]) =>
      method === 'pty.shutdown' ? shutdown.promise : request(method, ...rest)
    )
    mockMux.dispose.mockImplementation(() => shutdown.reject(new Error('Multiplexer disposed')))
    return shutdown
  }

  it('(i) End Terminals on a held-down host ends them over a channel nothing can see', async () => {
    const runtime = useRuntime()
    await invoke('ssh:disconnect')
    holdSessionsThatNeedTheRelay()
    mockConnectionManager.connect.mockClear()
    mockWindow.webContents.send.mockClear()
    mockMux.request.mockImplementation(async () => {
      expectNothingRegistered()
      return {}
    })

    await expect(invoke('ssh:terminateSessions')).resolves.toEqual({
      terminated: 1,
      unverifiable: 0
    })

    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    expect(mockMux.request).toHaveBeenCalledWith('pty.shutdown', {
      id: 'pty-1',
      immediate: true,
      keepHistory: false
    })
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(TARGET.id, 'pty-1', 'terminated')
    expect(sentStates(mockWindow.webContents.send)).toEqual([])
    expect(runtime.notifySshRelayReady).not.toHaveBeenCalled()
    expect(mockPortForwardManager.addForward).not.toHaveBeenCalled()
    expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled()
    expect(mockMux.dispose).toHaveBeenCalled()
    expectNothingRegistered()
    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('disconnected')
  })

  it('(i) a failed pty.shutdown still closes the channel and keeps the lease for a retry', async () => {
    await invoke('ssh:disconnect')
    holdSessionsThatNeedTheRelay()
    const shutdown = holdRelayShutdown()
    const terminate = invoke('ssh:terminateSessions')
    await vi.waitFor(() =>
      expect(mockMux.request).toHaveBeenCalledWith('pty.shutdown', expect.anything())
    )

    shutdown.reject(new Error('relay refused'))

    await expect(terminate).rejects.toThrow('Failed to terminate SSH host sessions')
    await expect(terminate).rejects.toThrow('relay refused')
    expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled()
    expect(mockMux.dispose).toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      TARGET.id,
      'pty-1',
      'terminated'
    )
    expectNothingRegistered()
  })

  it('(i) a drop mid-operation rejects it instead of letting the transport reconnect', async () => {
    await invoke('ssh:disconnect')
    holdSessionsThatNeedTheRelay()
    holdRelayShutdown()
    const terminate = invoke('ssh:terminateSessions')
    await vi.waitFor(() =>
      expect(mockMux.request).toHaveBeenCalledWith('pty.shutdown', expect.anything())
    )

    // What the transport reports when its socket drops and its reconnect ladder arms.
    reportMaintenanceState('reconnecting')
    const rejected = expect(terminate).rejects.toThrow('dropped (reconnecting)')

    // Closing the connection is what disarms the ladder's timer.
    await vi.waitFor(() => expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled())
    await rejected
    expect(mockMux.dispose).toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      TARGET.id,
      'pty-1',
      'terminated'
    )
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    expectNothingRegistered()
  })

  it("(ii) a user's Connect during End Terminals waits, then dials a full session of its own", async () => {
    const runtime = useRuntime()
    await invoke('ssh:disconnect')
    holdSessionsThatNeedTheRelay()
    const shutdown = holdRelayShutdown()
    mockConnectionManager.connect.mockClear()
    const terminate = invoke('ssh:terminateSessions')
    await vi.waitFor(() =>
      expect(mockMux.request).toHaveBeenCalledWith('pty.shutdown', expect.anything())
    )

    const connect = invoke('ssh:connect')
    await Promise.resolve()
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    shutdown.resolve(undefined)

    await expect(terminate).resolves.toEqual({ terminated: 1, unverifiable: 0 })
    await expect(connect).resolves.toMatchObject({ status: 'connected' })
    expect(mockConnectionManager.connect).toHaveBeenCalledTimes(1)
    expect(activeSessions.has(TARGET.id)).toBe(true)
    expect(mockConnectionManager.getConnection(TARGET.id)).toBeDefined()
    expect(runtime.notifySshRelayReady).toHaveBeenCalledWith(TARGET.id)
    expect(mockPortForwardManager.addForward).toHaveBeenCalled()
    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('connected')
  })

  it('(iii) Reset Relay on a held-down host force-stops over a channel nothing can see', async () => {
    await invoke('ssh:disconnect')
    mockConnectionManager.connect.mockClear()
    mockWindow.webContents.send.mockClear()
    mockForceStopRelayForTarget.mockImplementation(async () => expectNothingRegistered())

    await invoke('ssh:resetRelay')

    expect(mockForceStopRelayForTarget).toHaveBeenCalledWith(mockMaintenanceConnection, TARGET.id)
    expect(mockMaintenanceConnection.disconnect).toHaveBeenCalled()
    expect(mockConnectionManager.connect).not.toHaveBeenCalled()
    expect(sentStates(mockWindow.webContents.send)).toEqual([])
    expectNothingRegistered()
  })

  it('(iv) while the Disconnect holds, nothing registers a transport or session for the host', async () => {
    await invoke('ssh:connect')
    await invoke('ssh:disconnect')
    expectNothingRegistered()
    holdSessionsThatNeedTheRelay()
    const openMaintenance = mockMaintenanceConnection.connect.getMockImplementation()!
    mockMaintenanceConnection.connect.mockImplementation(async () => {
      expectNothingRegistered()
      await openMaintenance()
    })

    await expect(invoke('ssh:ensureConnected')).rejects.toMatchObject({
      code: SSH_DISCONNECTED_BY_USER_CODE
    })
    expectNothingRegistered()
    await invoke('ssh:resetRelay')
    expectNothingRegistered()
    await invoke('ssh:terminateSessions')
    expectNothingRegistered()
    await connectRegisteredSshTarget(TARGET.id, 'background').catch(() => undefined)
    expectNothingRegistered()

    expect(mockMaintenanceConnection.connect).toHaveBeenCalledTimes(2)
    expect(await invoke('ssh:getState')).toMatchObject({
      status: 'disconnected',
      disconnectedBy: 'user'
    })
  })

  it("(ii) a user's Connect while the terminate waits behind the Disconnect ends connected", async () => {
    const runtime = useRuntime()
    await invoke('ssh:connect')
    holdSessionsThatNeedTheRelay()
    let finishDisconnect!: () => void
    const disconnectTransport = mockConnectionManager.disconnect.getMockImplementation()!
    mockConnectionManager.disconnect.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((resolve) => {
          finishDisconnect = () => resolve(disconnectTransport(...args))
        })
    )
    const disconnect = invoke('ssh:disconnect')
    await vi.waitFor(() => expect(mockConnectionManager.disconnect).toHaveBeenCalledTimes(1))
    // Queued behind the Disconnect's lifecycle operation, as is the Connect after it.
    const terminate = invoke('ssh:terminateSessions')
    const userConnect = invoke('ssh:connect')
    mockConnectionManager.connect.mockClear()
    runtime.notifySshRelayReady.mockClear()
    mockPortForwardManager.addForward.mockClear()
    finishDisconnect()

    await disconnect
    await expect(terminate).resolves.toEqual({ terminated: 1, unverifiable: 0 })
    // Nothing End Terminals does may cancel the Connect that waited behind it.
    await expect(userConnect).resolves.toMatchObject({ status: 'connected' })
    expect(persistedTargets.get(TARGET.id)?.desiredConnection).toBe('connected')
    expect(mockConnectionManager.connect).toHaveBeenCalled()
    expect(mockConnectionManager.getConnection(TARGET.id)).toBeDefined()
    expect(activeSessions.get(TARGET.id)?.getState()).toBe('ready')
    expect(runtime.notifySshRelayReady).toHaveBeenLastCalledWith(TARGET.id)
    expect(mockPortForwardManager.addForward).toHaveBeenCalledTimes(1)
  })

  it("(ii) after the user's Connect, a relay reconnect restores forwards and republishes", async () => {
    const runtime = useRuntime()
    await invoke('ssh:disconnect')
    await expect(invoke('ssh:connect')).resolves.toMatchObject({ status: 'connected' })
    runtime.notifySshRelayReady.mockClear()
    mockPortForwardManager.addForward.mockClear()
    const session = activeSessions.get(TARGET.id)!
    const deploys = mocks.mockDeployAndLaunchRelay.mock.calls.length

    // The transport drops and comes back, which redeploys the relay and fires ready again.
    reportTransportState({ ...connectedState(), status: 'reconnecting', reconnectAttempt: 1 })
    reportTransportState(connectedState())
    await vi.waitFor(() => {
      expect(mocks.mockDeployAndLaunchRelay.mock.calls.length).toBe(deploys + 1)
      expect(session.getState()).toBe('ready')
    })

    expect(runtime.notifySshRelayReady).toHaveBeenCalledWith(TARGET.id)
    expect(mockPortForwardManager.addForward).toHaveBeenCalledTimes(1)
  })

  it("(h) a drop while the user's Disconnect waits its turn still publishes it disconnected", async () => {
    await invoke('ssh:connect')
    holdSessionsThatNeedTheRelay()
    let finishShutdown!: () => void
    mockPtyProvider.shutdown.mockReturnValue(
      new Promise<void>((resolve) => {
        finishShutdown = resolve
      })
    )
    // A live-session terminate holds the lifecycle queue, so the Disconnect parks behind it.
    const terminate = invoke('ssh:terminateSessions')
    await vi.waitFor(() => expect(mockPtyProvider.shutdown).toHaveBeenCalled())
    const disconnect = invoke('ssh:disconnect')
    mockWindow.webContents.send.mockClear()

    reportTransportState({
      targetId: TARGET.id,
      status: 'reconnecting',
      error: 'socket closed',
      reconnectAttempt: 1
    })

    expect(sentStates(mockWindow.webContents.send)).toEqual([
      expect.objectContaining({ status: 'disconnected', error: null, disconnectedBy: 'user' })
    ])
    finishShutdown()
    await terminate
    await disconnect
  })

  it('(h) publishes the Disconnect even when a failed connect left no connection object', async () => {
    mockConnectionManager.connect.mockRejectedValueOnce(new Error('connect ECONNREFUSED'))
    await expect(invoke('ssh:connect')).rejects.toThrow('ECONNREFUSED')
    expect(sentStates(mockWindow.webContents.send).at(-1)).toMatchObject({ status: 'error' })
    mockWindow.webContents.send.mockClear()

    await invoke('ssh:disconnect')

    expect(sentStates(mockWindow.webContents.send)).toEqual([
      expect.objectContaining({ status: 'disconnected', error: null, disconnectedBy: 'user' })
    ])
  })
})
