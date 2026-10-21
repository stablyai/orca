import { describe, expect, it, vi } from 'vitest'

vi.mock('../../browser/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: vi.fn()
}))
vi.mock('../../browser/browser-route-partition-storage-retirement', () => ({
  retireBrowserRoutePartitionStorageForEnvironment: vi.fn(async () => undefined)
}))

const { retireRemovedRuntimeEnvironment } = await import('./runtime-environment-removal-cleanup')

describe('retiring a removed runtime environment', () => {
  it('forgets the server’s session partition and its layout snapshot', async () => {
    const store = {
      removeWorkspaceSessionHost: vi.fn(),
      getRemoteLayoutSnapshot: vi.fn(),
      setRemoteLayoutSnapshot: vi.fn()
    }
    await retireRemovedRuntimeEnvironment('env 1', vi.fn(), store)
    expect(store.removeWorkspaceSessionHost).toHaveBeenCalledWith('runtime:env%201')
    expect(store.setRemoteLayoutSnapshot).toHaveBeenCalledWith('env 1', null, 'now')
  })
})
