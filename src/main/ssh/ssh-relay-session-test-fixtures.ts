import { vi, type Mock } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { SshConnection } from './ssh-connection'
import type { Store } from '../persistence'
import type { SshPortForwardManager } from './ssh-port-forward'
import { deployAndLaunchRelay } from './ssh-relay-deploy'

type SshRelaySessionTestDeps = {
  mockConn: SshConnection
  mockStore: Store
  mockPortForward: SshPortForwardManager
  getMainWindow: Mock<() => BrowserWindow | null>
  mockWindow: BrowserWindow
}

export function createMockDeps(): SshRelaySessionTestDeps {
  const mockConn = {} as SshConnection
  const mockStore = {
    getRepos: vi.fn().mockReturnValue([]),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn()
  } as unknown as Store
  const mockPortForward = {
    removeAllForwards: vi.fn()
  } as unknown as SshPortForwardManager
  const mockWindow = {
    isDestroyed: () => false,
    // Why: the port scanner visibility-gates its ticks; a visible mock window
    // keeps establish-path tests exercising the scan-on-ready behavior.
    isVisible: () => true,
    isMinimized: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
  const getMainWindow = vi.fn().mockReturnValue(mockWindow)
  return { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow }
}

export function mockDeploySuccess(): void {
  vi.mocked(deployAndLaunchRelay).mockResolvedValue({
    transport: {
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    },
    platform: 'linux-x64'
  })
}
