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

import { getSshConnectionManager, registerSshHandlers } from './ssh'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshPtyDataCallback } from '../providers/ssh-pty-provider-contract'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockDeployAndLaunchRelay,
  mockAcceptSshPtyOutputData,
  mockAcceptSshPtyOutputExit,
  mockPtyProvider,
  mockPortForwardManager,
  mockPortScannerCallbacks,
  mockNextConnectionManagers,
  mockNextPortForwardManagers
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const {
    ipcTestSource,
    handlers,
    mockStore,
    mockWindow,
    createMockWindow,
    createConnectionManagerMock,
    createPortForwardManagerMock
  } = harness

  beforeEach(harness.reset)

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
})
