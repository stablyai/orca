import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createSshIpcMocks } = await import('./ssh-ipc-module-mocks')
  return createSshIpcMocks()
})

vi.mock('../ssh/ssh-config-host-picker', () => mocks.sshConfigHostPicker)
vi.mock('electron', () => mocks.electron)
vi.mock('./ssh-pty-output-intake-registry', () => mocks.sshPtyOutputIntakeRegistry)
vi.mock('../ssh/ssh-connection-store', () => mocks.sshConnectionStore)
vi.mock('./ssh-host-server-connect', () => mocks.hostServerConnect)
vi.mock('../ssh/ssh-connection-manager', () => mocks.sshConnectionManager)
vi.mock('../ssh/ssh-channel-multiplexer', () => mocks.sshChannelMultiplexer)
vi.mock('../providers/ssh-pty-provider', () => mocks.sshPtyProvider)
vi.mock('../providers/ssh-filesystem-provider', () => mocks.sshFilesystemProvider)
vi.mock('./pty', () => mocks.pty)
vi.mock('../providers/ssh-filesystem-dispatch', () => mocks.sshFilesystemDispatch)
vi.mock('../providers/ssh-git-provider', () => mocks.sshGitProvider)
vi.mock('../providers/ssh-git-dispatch', () => mocks.sshGitDispatch)
vi.mock('../ssh/ssh-port-forward', () => mocks.sshPortForward)
vi.mock('../ssh/ssh-port-scanner', () => mocks.sshPortScanner)

import { getActiveMultiplexer } from './ssh'
import type { SshConnectionState, SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockMux,
  mockPortForwardManager
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const { handlers, mockStore } = harness

  beforeEach(harness.reset)

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

})
