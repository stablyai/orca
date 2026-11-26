import { afterEach, describe, expect, it, vi } from 'vitest'

const readMeta = vi.hoisted(() => vi.fn())

vi.mock('../profiles/browser-session-registry', () => ({
  browserSessionRegistry: { metadataPath: '/meta.json', defaultPartition: 'persist:orca-browser' }
}))
vi.mock('../profiles/browser-session-meta-store', () => ({
  readBrowserSessionMetaAsync: readMeta,
  updateBrowserSessionMetaAsync: vi.fn()
}))

import { loadBrowserProfileSiteListsWithRetry } from './browser-profile-site-list-store'
import {
  getBrowserProfileSiteListEntries,
  setBrowserProfileSiteList
} from './browser-session-site-list'

afterEach(() => {
  vi.useRealTimers()
  setBrowserProfileSiteList('work', [])
})

describe('loadBrowserProfileSiteListsWithRetry', () => {
  it('keeps retrying an unreadable file until its saved lists load', async () => {
    vi.useFakeTimers()
    readMeta
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ allowedHostsByProfileId: { work: ['example.com'] } })
    loadBrowserProfileSiteListsWithRetry()
    await vi.advanceTimersByTimeAsync(0)
    expect(getBrowserProfileSiteListEntries('work')).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(getBrowserProfileSiteListEntries('work')).toEqual(['example.com'])
    expect(readMeta).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(readMeta).toHaveBeenCalledTimes(3)
  })
})
