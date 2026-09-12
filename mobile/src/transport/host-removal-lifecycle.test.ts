import { beforeEach, describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())
const unregisterPushMock = vi.hoisted(() => vi.fn(async () => vi.fn()))
const forgetLogMock = vi.hoisted(() => vi.fn())

vi.mock('./persisted-connection-log-store', () => ({
  forgetConnectionLogHost: (hostId: string) => forgetLogMock(hostId)
}))

vi.mock('./host-store', () => ({
  removeHost: (hostId: string) => removeHostMock(hostId)
}))

vi.mock('../notifications/push-registration', () => ({
  unregisterPushForRemovedHost: (hostId: string) => unregisterPushMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
    unregisterPushMock.mockClear()
    forgetLogMock.mockClear()
  })

  it('closes the client only after metadata removal commits', async () => {
    let commitRemoval: (() => void) | null = null
    removeHostMock.mockReturnValue(new Promise<void>((resolve) => (commitRemoval = resolve)))
    const closeHostClient = vi.fn()
    const removal = removeHostAndCloseClient('host-1', closeHostClient)
    expect(closeHostClient).not.toHaveBeenCalled()
    expect(forgetLogMock).not.toHaveBeenCalled()
    commitRemoval?.()
    await removal
    expect(closeHostClient).toHaveBeenCalledWith('host-1')
    expect(forgetLogMock).toHaveBeenCalledWith('host-1')
    expect(closeHostClient.mock.invocationCallOrder[0]).toBeLessThan(
      forgetLogMock.mock.invocationCallOrder[0]
    )
  })

  it('keeps the client open when metadata removal fails', async () => {
    removeHostMock.mockRejectedValue(new Error('storage unavailable'))
    const closeHostClient = vi.fn()
    await expect(removeHostAndCloseClient('host-1', closeHostClient)).rejects.toThrow(
      'storage unavailable'
    )
    expect(closeHostClient).not.toHaveBeenCalled()
    expect(forgetLogMock).not.toHaveBeenCalled()
  })

  it('drops the gateway push registration before the credentials it needs are gone', async () => {
    removeHostMock.mockResolvedValue(undefined)
    await removeHostAndCloseClient('host-1', vi.fn())
    expect(unregisterPushMock).toHaveBeenCalledWith('host-1')
    expect(unregisterPushMock.mock.invocationCallOrder[0]).toBeLessThan(
      removeHostMock.mock.invocationCallOrder[0]
    )
  })
})
