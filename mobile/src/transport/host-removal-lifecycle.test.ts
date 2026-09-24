import { beforeEach, describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())
const unregisterPushMock = vi.hoisted(() => vi.fn(async () => vi.fn()))
const forgetUpdateFailuresMock = vi.hoisted(() => vi.fn(async () => undefined))
const deletePageCacheMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./host-store', () => ({
  removeHost: (hostId: string) => removeHostMock(hostId)
}))

vi.mock('../notifications/push-registration', () => ({
  unregisterPushForRemovedHost: (hostId: string) => unregisterPushMock(hostId)
}))

vi.mock('../mobile-web-shell/removed-host-shell-cache', () => ({
  forgetHostUpdateFailures: (hostId: string) => forgetUpdateFailuresMock(hostId),
  deleteHostPageCache: (hostId: string) => deletePageCacheMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
    unregisterPushMock.mockClear()
    forgetUpdateFailuresMock.mockClear()
    deletePageCacheMock.mockClear()
  })

  it('closes the client only after metadata removal commits', async () => {
    let commitRemoval: (() => void) | null = null
    removeHostMock.mockReturnValue(new Promise<void>((resolve) => (commitRemoval = resolve)))
    const closeHostClient = vi.fn()
    const removal = removeHostAndCloseClient('host-1', closeHostClient)
    expect(closeHostClient).not.toHaveBeenCalled()
    commitRemoval?.()
    await removal
    expect(closeHostClient).toHaveBeenCalledWith('host-1')
  })

  it('keeps the client open when metadata removal fails', async () => {
    removeHostMock.mockRejectedValue(new Error('storage unavailable'))
    const closeHostClient = vi.fn()
    await expect(removeHostAndCloseClient('host-1', closeHostClient)).rejects.toThrow(
      'storage unavailable'
    )
    expect(closeHostClient).not.toHaveBeenCalled()
  })

  it('drops the gateway push registration before the credentials it needs are gone', async () => {
    removeHostMock.mockResolvedValue(undefined)
    await removeHostAndCloseClient('host-1', vi.fn())
    expect(unregisterPushMock).toHaveBeenCalledWith('host-1')
    expect(unregisterPushMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeHostMock.mock.invocationCallOrder[0]
    )
  })

  it("forgets the host's recorded update failures once it is gone", async () => {
    removeHostMock.mockResolvedValue(undefined)
    await removeHostAndCloseClient('host-1', vi.fn())
    expect(forgetUpdateFailuresMock).toHaveBeenCalledWith('host-1')
  })

  it('keeps them while the host is still paired', async () => {
    removeHostMock.mockRejectedValue(new Error('storage unavailable'))
    await expect(removeHostAndCloseClient('host-1', vi.fn())).rejects.toThrow()
    expect(forgetUpdateFailuresMock).not.toHaveBeenCalled()
  })

  it('still closes the client when forgetting them fails', async () => {
    removeHostMock.mockResolvedValue(undefined)
    forgetUpdateFailuresMock.mockRejectedValueOnce(new Error('disk'))
    const closeHostClient = vi.fn()
    await removeHostAndCloseClient('host-1', closeHostClient)
    expect(closeHostClient).toHaveBeenCalledWith('host-1')
  })

  it("deletes the host's page cache once it is gone, and keeps it while it is still paired", async () => {
    removeHostMock.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(removeHostAndCloseClient('host-1', vi.fn())).rejects.toThrow()
    expect(deletePageCacheMock).not.toHaveBeenCalled()
    removeHostMock.mockResolvedValue(undefined)
    await removeHostAndCloseClient('host-1', vi.fn())
    expect(deletePageCacheMock).toHaveBeenCalledWith('host-1')
    expect(removeHostMock.mock.invocationCallOrder.at(-1)).toBeLessThan(
      deletePageCacheMock.mock.invocationCallOrder[0]
    )
  })

  it('still removes the host when its page cache cannot be deleted', async () => {
    removeHostMock.mockResolvedValue(undefined)
    deletePageCacheMock.mockRejectedValueOnce(new Error('disk'))
    const closeHostClient = vi.fn()
    await expect(removeHostAndCloseClient('host-1', closeHostClient)).resolves.toBeUndefined()
    expect(closeHostClient).toHaveBeenCalledWith('host-1')
  })
})
