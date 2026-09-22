import { beforeEach, describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())
const unregisterPushMock = vi.hoisted(() => vi.fn(async () => vi.fn()))
const forgetUpdateFailuresMock = vi.hoisted(() => vi.fn(async () => undefined))

vi.mock('./host-store', () => ({
  removeHost: (hostId: string) => removeHostMock(hostId)
}))

vi.mock('../notifications/push-registration', () => ({
  unregisterPushForRemovedHost: (hostId: string) => unregisterPushMock(hostId)
}))

vi.mock('../mobile-web-shell/forget-host-update-failures', () => ({
  forgetHostUpdateFailures: (hostId: string) => forgetUpdateFailuresMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
    unregisterPushMock.mockClear()
    forgetUpdateFailuresMock.mockClear()
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
})
