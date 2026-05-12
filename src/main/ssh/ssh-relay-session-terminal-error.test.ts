import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SshRelaySession } from './ssh-relay-session'
import type { SshConnection } from './ssh-connection'
import type { Store } from '../persistence'
import type { SshPortForwardManager } from './ssh-port-forward'
import { RelayVersionMismatchError } from './ssh-relay-version-mismatch-error'
import type { BrowserWindow } from 'electron'

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

vi.mock('./ssh-channel-multiplexer', () => {
  return {
    SshChannelMultiplexer: class MockSshChannelMultiplexer {
      notify = vi.fn()
      request = vi.fn().mockResolvedValue([])
      onNotification = vi.fn().mockReturnValue(() => {})
      onDispose = vi.fn().mockReturnValue(() => {})
      dispose = vi.fn()
      isDisposed = vi.fn().mockReturnValue(false)
    }
  }
})

vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))

vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined)
  }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')

function createMockDeps(): {
  mockConn: SshConnection
  mockStore: Store
  mockPortForward: SshPortForwardManager
  getMainWindow: () => BrowserWindow | null
} {
  const mockConn = {} as SshConnection
  const mockStore = {
    getRepos: vi.fn().mockReturnValue([])
  } as unknown as Store
  const mockPortForward = {
    removeAllForwards: vi.fn()
  } as unknown as SshPortForwardManager
  const mockWindow = {
    isDestroyed: (): boolean => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
  const getMainWindow = vi.fn().mockReturnValue(mockWindow) as unknown as () => BrowserWindow | null
  return { mockConn, mockStore, mockPortForward, getMainWindow }
}

function mockDeploySuccess(): void {
  const mockTransport = {
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }
  vi.mocked(deployAndLaunchRelay).mockResolvedValue({
    transport: mockTransport,
    platform: 'linux-x64'
  })
}

describe('SshRelaySession terminal relay error (RelayVersionMismatchError)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDeploySuccess()
  })

  it('fires onTerminalRelayError on initial establish() and rethrows', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    const onTerminal = vi.fn()
    const onLost = vi.fn()
    session.setOnTerminalRelayError(onTerminal)
    session.setOnRelayLost(onLost)

    const mismatchErr = new RelayVersionMismatchError(
      '0.1.0+aaa',
      '0.1.0+bbb',
      '[relay-connect] Handshake mismatch...'
    )
    vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(mismatchErr)

    await expect(session.establish(mockConn)).rejects.toBe(mismatchErr)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('target-1', mismatchErr)
    expect(onLost).not.toHaveBeenCalled()
    expect(session.getState()).toBe('idle')
  })

  it('does NOT fire onTerminalRelayError on a generic establish failure', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    const onTerminal = vi.fn()
    session.setOnTerminalRelayError(onTerminal)

    vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(new Error('boom'))

    await expect(session.establish(mockConn)).rejects.toThrow('boom')
    expect(onTerminal).not.toHaveBeenCalled()
    expect(session.getState()).toBe('idle')
  })

  it('fires onTerminalRelayError on reconnect() when deploy throws RelayVersionMismatchError', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    const onTerminal = vi.fn()
    session.setOnTerminalRelayError(onTerminal)

    await session.establish(mockConn)
    expect(session.getState()).toBe('ready')

    const mismatchErr = new RelayVersionMismatchError('0.1.0+old', '0.1.0+new', '')
    vi.mocked(deployAndLaunchRelay).mockRejectedValueOnce(mismatchErr)

    await session.reconnect(mockConn)
    expect(onTerminal).toHaveBeenCalledTimes(1)
    expect(onTerminal).toHaveBeenCalledWith('target-1', mismatchErr)
  })
})
