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

import { registerSshHandlers } from './ssh'
import type { SshTarget } from '../../shared/ssh-types'
import { createSshIpcHarness } from './ssh-ipc-test-harness'

const {
  mockSshStore,
  mockConnectionManager,
  mockPortForwardManager,
  mockNextConnectionManagers,
  mockNextPortForwardManagers
} = mocks

describe('SSH IPC handlers', () => {
  const harness = createSshIpcHarness(mocks)
  const {
    handlers,
    mockStore,
    mockWindow,
    createMockWindow,
    createConnectionManagerMock,
    createPortForwardManagerMock
  } = harness

  beforeEach(harness.reset)

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
