import { beforeEach, describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())
const restorePushMock = vi.hoisted(() => vi.fn())
const unregisterPushMock = vi.hoisted(() => vi.fn(async (_hostId: string) => restorePushMock))
const forgetUpdateFailuresMock = vi.hoisted(() => vi.fn(async (_hostId: string) => undefined))
const deletePageCacheMock = vi.hoisted(() => vi.fn(async (_hostId: string) => undefined))
const wipeHostStoreMock = vi.hoisted(() => vi.fn(async (_hostId: string) => undefined))

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

vi.mock('../device-store/device-store', () => ({
  wipeHostStore: (hostId: string) => wipeHostStoreMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
    unregisterPushMock.mockClear()
    restorePushMock.mockClear()
    forgetUpdateFailuresMock.mockClear()
    deletePageCacheMock.mockClear()
    wipeHostStoreMock.mockClear()
  })

  it('closes the client only after metadata removal commits', async () => {
    let commitRemoval: (() => void) | undefined
    const removalStarted = new Promise<void>((resolve) => {
      removeHostMock.mockImplementation(() => {
        resolve()
        return new Promise<void>((commit) => (commitRemoval = commit))
      })
    })
    const closeHostClient = vi.fn()
    const removal = removeHostAndCloseClient('host-1', closeHostClient)
    await removalStarted
    expect(removeHostMock).toHaveBeenCalledExactlyOnceWith('host-1')
    expect(closeHostClient).not.toHaveBeenCalled()
    commitRemoval?.()
    await removal
    expect(closeHostClient).toHaveBeenCalledExactlyOnceWith('host-1')
    expect(restorePushMock).not.toHaveBeenCalled()
  })

  it('keeps the client open when metadata removal fails', async () => {
    const failure = new Error('storage unavailable')
    removeHostMock.mockRejectedValue(failure)
    const closeHostClient = vi.fn()
    await expect(removeHostAndCloseClient('host-1', closeHostClient)).rejects.toBe(failure)
    expect(closeHostClient).not.toHaveBeenCalled()
    expect(restorePushMock).toHaveBeenCalledOnce()
  })

  it('drops the gateway push registration before the credentials it needs are gone', async () => {
    removeHostMock.mockResolvedValue(undefined)
    let finishUnregister: (() => void) | undefined
    unregisterPushMock.mockImplementationOnce(
      () => new Promise((resolve) => (finishUnregister = () => resolve(restorePushMock)))
    )
    const removal = removeHostAndCloseClient('host-1', vi.fn())
    expect(unregisterPushMock).toHaveBeenCalledExactlyOnceWith('host-1')
    expect(removeHostMock).not.toHaveBeenCalled()
    finishUnregister?.()
    await removal
    expect(unregisterPushMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeHostMock.mock.invocationCallOrder[0]
    )
  })
})
