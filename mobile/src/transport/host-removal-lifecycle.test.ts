import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  // Why removeItem is here: clearWatermark() swallows its own failures, so a mock
  // missing this method turns the persisted-watermark cleanup into a caught
  // TypeError — the assertion below would pass even if the call were deleted.
  removeItem: vi.fn(async () => undefined)
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))
const {
  removeHostMock,
  deleteConnectionLogMock,
  removeMobileWebHostCacheMock,
  clearMobileWebColdResumeRouteForHostMock
} = vi.hoisted(() => ({
  removeHostMock: vi.fn(),
  deleteConnectionLogMock: vi.fn(),
  removeMobileWebHostCacheMock: vi.fn(),
  clearMobileWebColdResumeRouteForHostMock: vi.fn()
}))

vi.mock('./host-store', () => ({
  removeHost: (hostId: string) => removeHostMock(hostId)
}))
vi.mock('./persisted-connection-log-store', () => ({
  connectionLogStore: { delete: deleteConnectionLogMock }
}))
vi.mock('../mobile-web/mobile-web-native-stager', () => ({
  removeMobileWebHostCache: (publicKey: string) => removeMobileWebHostCacheMock(publicKey)
}))
vi.mock('../mobile-web/mobile-web-cold-resume-route', () => ({
  clearMobileWebColdResumeRouteForHost: (hostId: string) =>
    clearMobileWebColdResumeRouteForHostMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'
import {
  getHostNotificationSession,
  resetHostNotificationSessionsForTests
} from '../notifications/notification-reconnect-catchup'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
    asyncStorage.removeItem.mockClear()
    resetHostNotificationSessionsForTests()
    deleteConnectionLogMock.mockReset()
    removeMobileWebHostCacheMock.mockReset().mockResolvedValue(undefined)
    clearMobileWebColdResumeRouteForHostMock.mockReset().mockResolvedValue(undefined)
  })

  it('closes the client only after metadata removal commits', async () => {
    let commitRemoval: (() => void) | null = null
    removeHostMock.mockReturnValue(
      new Promise<void>((resolve) => {
        commitRemoval = resolve
      })
    )
    const closeHostClient = vi.fn()

    const removal = removeHostAndCloseClient('host-1', 'public-key-1', closeHostClient)
    expect(closeHostClient).not.toHaveBeenCalled()
    commitRemoval?.()
    await removal

    expect(closeHostClient).toHaveBeenCalledWith('host-1')
    expect(deleteConnectionLogMock).toHaveBeenCalledWith('host-1')
    expect(removeMobileWebHostCacheMock).toHaveBeenCalledWith('public-key-1')
    expect(clearMobileWebColdResumeRouteForHostMock).toHaveBeenCalledWith('host-1')
  })

  it('keeps the client open when metadata removal fails', async () => {
    removeHostMock.mockRejectedValue(new Error('storage unavailable'))
    const closeHostClient = vi.fn()

    await expect(
      removeHostAndCloseClient('host-1', 'public-key-1', closeHostClient)
    ).rejects.toThrow('storage unavailable')
    expect(closeHostClient).not.toHaveBeenCalled()
  })

  it('retires the notification session so a removed host leaves nothing behind', async () => {
    // Round-1 review finding: the session lives at module scope (it must survive the
    // subscription teardown a reconnect performs), so removal is the only thing that
    // can retire it. Left behind, each remove/re-pair cycle strands a session plus up
    // to 512 seen keys, and a re-paired host inherits a watermark it never earned.
    removeHostMock.mockResolvedValue(undefined)
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredSeq = 42
    session.lastDeliveredEpoch = 'epoch-A'

    await removeHostAndCloseClient('host-1', 'public-key-1', vi.fn())

    // A fresh session for the same id — not the retained one.
    const afterRemoval = getHostNotificationSession('host-1')
    expect(afterRemoval).not.toBe(session)
    expect(afterRemoval.lastDeliveredSeq).toBe(0)
    expect(afterRemoval.lastDeliveredEpoch).toBeNull()
  })

  it('erases the persisted watermark, not just the in-memory session', async () => {
    // Why separately from the test above: the session is process-local, the
    // watermark is not. Retiring only the session lets a re-pair of the same host
    // read the old seq off disk and resume against a counter it never saw — the
    // catch-up would then start above the real cut and drop everything below it.
    removeHostMock.mockResolvedValue(undefined)

    await removeHostAndCloseClient('host-1', 'public-key-1', vi.fn())
    // clearWatermark is fire-and-forget; let its microtask land.
    await Promise.resolve()

    expect(asyncStorage.removeItem).toHaveBeenCalledWith('orca:mobileNotificationsWatermark:host-1')
  })

  it('unpairs even when the hybrid native cache deletion fails', async () => {
    // The Kotlin/Swift store throws on an empty identity or a failed tree delete, and that
    // cache does not exist at all on a native build — neither may strand a paired host.
    removeMobileWebHostCacheMock.mockRejectedValue(new Error('native cache unavailable'))
    removeHostMock.mockResolvedValue(undefined)
    const closeHostClient = vi.fn()

    await expect(
      removeHostAndCloseClient('host-1', 'public-key-1', closeHostClient)
    ).resolves.toBeUndefined()

    expect(removeHostMock).toHaveBeenCalledWith('host-1')
    expect(closeHostClient).toHaveBeenCalledWith('host-1')
    expect(deleteConnectionLogMock).toHaveBeenCalledWith('host-1')
  })

  it('unpairs even when cold-route cleanup cannot commit', async () => {
    clearMobileWebColdResumeRouteForHostMock.mockRejectedValue(
      new Error('route storage unavailable')
    )
    removeHostMock.mockResolvedValue(undefined)
    const closeHostClient = vi.fn()

    await expect(
      removeHostAndCloseClient('host-1', 'public-key-1', closeHostClient)
    ).resolves.toBeUndefined()

    expect(removeHostMock).toHaveBeenCalledWith('host-1')
    expect(closeHostClient).toHaveBeenCalledWith('host-1')
  })

  it('deletes the package cache only after the client that served it is closed', async () => {
    // The hosted WebView reads its document out of that cache: deleting it first turned every
    // later asset request into a 403 under a still-mounted document.
    const order: string[] = []
    removeHostMock.mockImplementation(async () => {
      order.push('remove-metadata')
    })
    removeMobileWebHostCacheMock.mockImplementation(async () => {
      order.push('delete-cache')
    })
    clearMobileWebColdResumeRouteForHostMock.mockImplementation(async () => {
      order.push('clear-cold-route')
    })

    await removeHostAndCloseClient('host-1', 'public-key-1', () => order.push('close-client'))

    expect(order).toEqual(['remove-metadata', 'close-client', 'delete-cache', 'clear-cold-route'])
  })

  it('keeps the package cache when the unpair itself never commits', async () => {
    removeHostMock.mockRejectedValue(new Error('storage unavailable'))

    await expect(removeHostAndCloseClient('host-1', 'public-key-1', vi.fn())).rejects.toThrow(
      'storage unavailable'
    )

    expect(removeMobileWebHostCacheMock).not.toHaveBeenCalled()
  })

  it('forgets removed-host logs even when client teardown throws', async () => {
    removeHostMock.mockResolvedValue(undefined)
    const closeHostClient = vi.fn(() => {
      throw new Error('close failed')
    })

    await expect(
      removeHostAndCloseClient('host-1', 'public-key-1', closeHostClient)
    ).rejects.toThrow('close failed')
    expect(deleteConnectionLogMock).toHaveBeenCalledWith('host-1')
  })

  // Why: the Remove tap must not depend on a key the screen loads asynchronously, so an
  // unresolvable key is a skipped cache purge rather than a refused unpair.
  it('unpairs when the hybrid cache key could not be resolved', async () => {
    removeHostMock.mockResolvedValue(undefined)
    const forget = vi.fn()

    await removeHostAndCloseClient('host-1', '', forget)

    expect(removeMobileWebHostCacheMock).not.toHaveBeenCalled()
    expect(removeHostMock).toHaveBeenCalledWith('host-1')
    expect(forget).toHaveBeenCalledWith('host-1')
  })
})
