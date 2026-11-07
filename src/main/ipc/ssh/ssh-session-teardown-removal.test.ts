// #37949: every removal of a saved SSH target (Settings, `orca host rm`, a paired client, a recipe
// VM's cleanup) ends in removeRegisteredSshTarget, so the window's cleanup must happen there.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const settings: { hostSettingOverrides?: Record<string, Record<string, string>> } = {}
  return {
    removeTarget: vi.fn(),
    send: vi.fn(),
    settings,
    updateSettings: vi.fn()
  }
})

vi.mock('../../ssh/targets/ssh-target-registry', () => ({
  getSshTargetRegistryStore: () => ({ removeTarget: mocks.removeTarget })
}))
vi.mock('./ssh-ipc-context', () => ({
  getCurrentMainWindow: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }),
  connectionManager: { disconnect: vi.fn(async () => {}) },
  portForwardManager: null,
  persistedStore: {
    getSettings: () => mocks.settings,
    updateSettings: mocks.updateSettings,
    removeSshRemotePtyLeases: vi.fn()
  }
}))
vi.mock('./ssh-target-lifecycle-queue', () => ({
  runTargetLifecycle: (_targetId: string, run: () => Promise<void>) => run()
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnelsForTarget: vi.fn(async () => {})
}))
vi.mock('../../browser/routing/local-host-partitions/local-ssh-browser-partitions', () => ({
  releaseLocalSshBrowserPartitionsForTarget: vi.fn(async () => {})
}))
vi.mock('../../browser/routing/partitions/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForLocalSshTarget: vi.fn(async () => {})
}))

const { removeRegisteredSshTarget } = await import('./ssh-session-teardown')

describe('removing a saved SSH target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.settings.hostSettingOverrides = {
      'ssh:ssh-1': { displayLabel: 'Renamed', defaultWorktreeLocation: '/srv' },
      'ssh:ssh-2': { displayLabel: 'Other' }
    }
  })

  it("tells the window and drops the host's rename after the target is gone", async () => {
    await removeRegisteredSshTarget('ssh-1')

    expect(mocks.removeTarget).toHaveBeenCalledWith('ssh-1')
    expect(mocks.send).toHaveBeenCalledWith('ssh:target-removed', { targetId: 'ssh-1' })
    expect(mocks.removeTarget.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0]!
    )
    expect(mocks.updateSettings).toHaveBeenCalledWith(
      {
        hostSettingOverrides: {
          'ssh:ssh-1': { defaultWorktreeLocation: '/srv' },
          'ssh:ssh-2': { displayLabel: 'Other' }
        }
      },
      { notifyListeners: true }
    )
  })
})
