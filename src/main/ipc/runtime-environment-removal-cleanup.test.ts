import { describe, expect, it, vi } from 'vitest'

vi.mock('../browser/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: vi.fn()
}))
vi.mock('../browser/browser-route-partition-storage-retirement', () => ({
  retireBrowserRoutePartitionStorageForEnvironment: vi.fn(async () => undefined)
}))

const { retireRemovedRuntimeEnvironment } = await import('./runtime-environment-removal-cleanup')

describe('retiring a removed runtime environment', () => {
  it('forgets the server’s workspace session partition under its runtime host id', async () => {
    const forgetHostSession = vi.fn()
    await retireRemovedRuntimeEnvironment('env 1', vi.fn(), forgetHostSession)
    expect(forgetHostSession).toHaveBeenCalledWith('runtime:env%201')
  })

  it('waits for the durable session archive before completing managed-server cleanup', async () => {
    const archive = Promise.withResolvers<void>()
    const invalidateTransport = vi.fn()
    const completed = vi.fn()
    const retiring = retireRemovedRuntimeEnvironment(
      'env',
      invalidateTransport,
      () => archive.promise
    ).then(completed)
    await Promise.resolve()
    expect(invalidateTransport).toHaveBeenCalledWith('env')
    expect(completed).not.toHaveBeenCalled()
    archive.resolve()
    await retiring
    expect(completed).toHaveBeenCalledOnce()
  })

  it('starts transport cleanup and reports a failed session archive', async () => {
    const invalidateTransport = vi.fn()
    await expect(
      retireRemovedRuntimeEnvironment('env', invalidateTransport, async () => {
        throw new Error('archive failed')
      })
    ).rejects.toThrow('archive failed')
    expect(invalidateTransport).toHaveBeenCalledWith('env')
  })
})
