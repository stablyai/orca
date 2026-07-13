import { beforeEach, describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())

vi.mock('./host-store', () => ({
  removeHost: (hostId: string) => removeHostMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
  })

  it('closes the client only after metadata removal commits', async () => {
    let commitRemoval: (() => void) | null = null
    removeHostMock.mockReturnValue(
      new Promise<void>((resolve) => {
        commitRemoval = resolve
      })
    )
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
})
