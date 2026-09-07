import { beforeEach, describe, expect, it, vi } from 'vitest'

const removeHostMock = vi.hoisted(() => vi.fn())
const asyncStorage = vi.hoisted(() => ({
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => undefined),
  // Why removeItem is here: clearWatermark() swallows its own failures, so a mock
  // missing this method turns the persisted-watermark cleanup into a caught
  // TypeError — the assertion below would pass even if the call were deleted.
  removeItem: vi.fn(async () => undefined)
}))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorage }))

vi.mock('./host-store', () => ({
  removeHost: (hostId: string) => removeHostMock(hostId)
}))

import { removeHostAndCloseClient } from './host-removal-lifecycle'
import {
  getSessionTabStripCacheKey,
  readCachedSessionTabStrip,
  resetSessionTabStripCacheForTests,
  saveCachedSessionTabStrip
} from '../cache/session-tab-strip-cache'
import {
  getHostNotificationSession,
  resetHostNotificationSessionsForTests
} from '../notifications/notification-reconnect-catchup'

describe('host removal lifecycle', () => {
  beforeEach(() => {
    removeHostMock.mockReset()
    asyncStorage.removeItem.mockClear()
    asyncStorage.setItem.mockReset().mockResolvedValue(undefined)
    resetHostNotificationSessionsForTests()
    resetSessionTabStripCacheForTests()
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

  it('retires the notification session so a removed host leaves nothing behind', async () => {
    // Round-1 review finding: the session lives at module scope (it must survive the
    // subscription teardown a reconnect performs), so removal is the only thing that
    // can retire it. Left behind, each remove/re-pair cycle strands a session plus up
    // to 512 seen keys, and a re-paired host inherits a watermark it never earned.
    removeHostMock.mockResolvedValue(undefined)
    const session = getHostNotificationSession('host-1')
    session.lastDeliveredSeq = 42
    session.lastDeliveredEpoch = 'epoch-A'

    await removeHostAndCloseClient('host-1', vi.fn())

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

    await removeHostAndCloseClient('host-1', vi.fn())
    // clearWatermark is fire-and-forget; let its microtask land.
    await Promise.resolve()

    expect(asyncStorage.removeItem).toHaveBeenCalledWith('orca:mobileNotificationsWatermark:host-1')
  })

  it('drops the removed host cached tab strip and keeps every other host', async () => {
    // Why: the strip is plaintext and nothing else in the app ever expires an entry, so a
    // forgotten host would keep its tab titles on disk and get them rewritten by the next
    // save for any surviving host.
    removeHostMock.mockResolvedValue(undefined)
    const removed = getSessionTabStripCacheKey('host-1', 'wt-1')
    const kept = getSessionTabStripCacheKey('host-2', 'wt-1')
    const strip = {
      tabs: [{ id: 'tab-1', type: 'terminal' as const, title: 'Terminal', agentId: null }],
      activeTabId: 'tab-1'
    }
    saveCachedSessionTabStrip(removed, strip)
    saveCachedSessionTabStrip(kept, strip)

    await removeHostAndCloseClient('host-1', vi.fn())
    // Fire-and-forget, like clearWatermark above; let its microtasks land.
    await vi.waitFor(() => expect(readCachedSessionTabStrip(removed)).toBeNull())

    expect(readCachedSessionTabStrip(kept)?.tabs).toHaveLength(1)
  })
  it('finishes the removal even when the cached tab strip write fails', async () => {
    // The metadata removal has already committed and the client is closed by this
    // point, so a cache write that fails must be reported, not thrown: surfacing it
    // as a failed removal would leave the user staring at a host that is really gone.
    removeHostMock.mockResolvedValue(undefined)
    asyncStorage.setItem.mockRejectedValue(new Error('storage full'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const closeHostClient = vi.fn()

    await expect(removeHostAndCloseClient('host-1', closeHostClient)).resolves.toBeUndefined()

    expect(closeHostClient).toHaveBeenCalledWith('host-1')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
