import { vi, type Mock } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { SshConnection } from './ssh-connection'
import type { PersistPtyBindingArgs } from '../persistence/loading-store/pty-binding-persistence'
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

const persistedBindings = new WeakMap<Store, PersistPtyBindingArgs[]>()

export function recordedPtyBindings(store: Store): readonly PersistPtyBindingArgs[] {
  return persistedBindings.get(store) ?? []
}

export function createMockDeps(): SshRelaySessionTestDeps {
  const bindings: PersistPtyBindingArgs[] = []
  const mockConn = {} as SshConnection
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The relay fixture implements the Store methods exercised by session establishment and teardown.
  const mockStore = {
    // Why: these suites pin remote hook delivery, not the consent gate itself.
    getSettings: vi.fn().mockReturnValue({ agentStatusHooksEnabled: true }),
    getRepos: vi.fn().mockReturnValue([]),
    getSshPtyConsumerRecovery: vi.fn().mockReturnValue(null),
    upsertSshPtyConsumerRecovery: vi.fn(),
    removeSshPtyConsumerRecovery: vi.fn(),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    reconcileSshRemotePtyLeasesForTarget: vi.fn(),
    getWorkspaceSession: vi.fn(),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn(),
    markSshRemotePtyLeasesAsync: vi.fn(),
    markSshRemotePtyLeasesForShutdown: vi.fn(),
    markSshRemotePtyLeasesAttachedAsync: vi.fn(),
    getSshRemotePtyKillIntents: vi.fn().mockReturnValue([]),
    pruneExpiredSshRemotePtyKillIntents: vi.fn(),
    recordSshRemotePtyKillIntent: vi.fn(),
    clearSshRemotePtyKillIntent: vi.fn(),
    noteSshRemotePtyKillReplayAttempt: vi.fn(),
    persistPtyBinding: vi.fn(async (input: Parameters<Store['persistPtyBinding']>[0]) => {
      const binding = typeof input === 'function' ? input() : input
      if (!binding) {
        return false
      }
      bindings.push(binding)
      return true
    })
  } as unknown as Store
  persistedBindings.set(mockStore, bindings)
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
