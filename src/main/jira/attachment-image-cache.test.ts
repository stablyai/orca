import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  _getAttachmentImageCacheSize,
  _resetAttachmentImageCache,
  clearAttachmentImagesForSite,
  getCachedAttachmentDataUrl,
  loadAttachmentDataUrlWithCache,
  setCachedAttachmentDataUrl
} from './attachment-image-cache'

describe('attachment image cache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    _resetAttachmentImageCache()
  })

  afterEach(() => {
    _resetAttachmentImageCache()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns cached data urls and isolates sites', () => {
    setCachedAttachmentDataUrl({
      siteId: 'a',
      attachmentId: '1',
      dataUrl: 'data:image/png;base64,AA==',
      byteSize: 1
    })
    setCachedAttachmentDataUrl({
      siteId: 'b',
      attachmentId: '1',
      dataUrl: 'data:image/png;base64,BB==',
      byteSize: 1
    })
    expect(getCachedAttachmentDataUrl('a', '1')).toBe('data:image/png;base64,AA==')
    expect(getCachedAttachmentDataUrl('b', '1')).toBe('data:image/png;base64,BB==')
    clearAttachmentImagesForSite('a')
    expect(getCachedAttachmentDataUrl('a', '1')).toBeNull()
    expect(getCachedAttachmentDataUrl('b', '1')).toBe('data:image/png;base64,BB==')
  })

  it('singleflights concurrent loads and does not cache failures', async () => {
    let calls = 0
    let resolveLoad: (value: { dataUrl: string; byteSize: number } | null) => void = () => {}
    const load = () =>
      new Promise<{ dataUrl: string; byteSize: number } | null>((resolve) => {
        calls += 1
        resolveLoad = resolve
      })

    const p1 = loadAttachmentDataUrlWithCache({ siteId: 's', attachmentId: '1', load })
    const p2 = loadAttachmentDataUrlWithCache({ siteId: 's', attachmentId: '1', load })
    expect(calls).toBe(1)
    resolveLoad(null)
    expect(await p1).toBeNull()
    expect(await p2).toBeNull()
    expect(getCachedAttachmentDataUrl('s', '1')).toBeNull()

    const p3 = loadAttachmentDataUrlWithCache({
      siteId: 's',
      attachmentId: '1',
      load: async () => ({ dataUrl: 'data:image/png;base64,OK==', byteSize: 2 })
    })
    expect(await p3).toBe('data:image/png;base64,OK==')
    expect(_getAttachmentImageCacheSize()).toBe(1)
  })

  it('does not repopulate after "disconnect all" when the site was cleared before', async () => {
    // Summed epochs read the same before a global clear (1 + 0) and after it (0 + 1).
    clearAttachmentImagesForSite('site-a')

    let resolveLoad: (value: { dataUrl: string; byteSize: number } | null) => void = () => {}
    const inFlight = loadAttachmentDataUrlWithCache({
      siteId: 'site-a',
      attachmentId: '1',
      load: () =>
        new Promise<{ dataUrl: string; byteSize: number } | null>((resolve) => {
          resolveLoad = resolve
        })
    })

    clearAttachmentImagesForSite()
    resolveLoad({ dataUrl: 'data:image/png;base64,SECRET==', byteSize: 4 })

    // The waiter still gets its bytes; nothing survives in the cache.
    expect(await inFlight).toBe('data:image/png;base64,SECRET==')
    expect(getCachedAttachmentDataUrl('site-a', '1')).toBeNull()
    expect(_getAttachmentImageCacheSize()).toBe(0)
  })

  it('still caches a load that spans no clear at all', async () => {
    clearAttachmentImagesForSite('site-a')

    const dataUrl = await loadAttachmentDataUrlWithCache({
      siteId: 'site-a',
      attachmentId: '1',
      load: async () => ({ dataUrl: 'data:image/png;base64,OK==', byteSize: 2 })
    })

    expect(dataUrl).toBe('data:image/png;base64,OK==')
    expect(getCachedAttachmentDataUrl('site-a', '1')).toBe('data:image/png;base64,OK==')
  })

  function storeImage(siteId: string, attachmentId: string): void {
    setCachedAttachmentDataUrl({
      siteId,
      attachmentId,
      dataUrl: `data:image/png;base64,${attachmentId}`,
      byteSize: 2
    })
  }

  it('releases expired images while idle at the existing deadline', () => {
    storeImage('site-a', 'image')
    vi.advanceTimersByTime(30 * 60_000 - 1)
    expect(_getAttachmentImageCacheSize()).toBe(1)

    vi.advanceTimersByTime(1)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not extend image lifetime when a cache hit changes LRU order', () => {
    storeImage('site-a', 'old')
    vi.advanceTimersByTime(60_000)
    storeImage('site-b', 'new')
    expect(getCachedAttachmentDataUrl('site-a', 'old')).not.toBeNull()

    vi.advanceTimersByTime(29 * 60_000)
    expect(_getAttachmentImageCacheSize()).toBe(1)
    expect(getCachedAttachmentDataUrl('site-a', 'old')).toBeNull()
    expect(getCachedAttachmentDataUrl('site-b', 'new')).not.toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps an overwritten image until its new deadline with one timer', () => {
    storeImage('site-a', 'image')
    vi.advanceTimersByTime(60_000)
    storeImage('site-a', 'image')
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(29 * 60_000)
    expect(_getAttachmentImageCacheSize()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([undefined, 'site-a'])('cancels expiry work when the last site clears: %s', (siteId) => {
    storeImage('site-a', 'image')
    expect(vi.getTimerCount()).toBe(1)
    clearAttachmentImagesForSite(siteId)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds the rescheduled delay when the wall clock moves far backward', () => {
    const timeout = vi.spyOn(globalThis, 'setTimeout')
    storeImage('site-a', 'image')
    vi.setSystemTime(-MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(30 * 60_000)
    expect(_getAttachmentImageCacheSize()).toBe(1)
    expect(timeout.mock.calls.at(-1)?.[1]).toBe(MAX_TIMER_DELAY_MS)
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the 96-entry limit and LRU eviction without extending the hit lifetime', () => {
    for (let id = 0; id < 96; id += 1) {
      storeImage('site-a', String(id))
    }
    vi.advanceTimersByTime(60_000)
    expect(getCachedAttachmentDataUrl('site-a', '0')).not.toBeNull()
    storeImage('site-a', '96')

    expect(_getAttachmentImageCacheSize()).toBe(96)
    expect(getCachedAttachmentDataUrl('site-a', '0')).not.toBeNull()
    expect(getCachedAttachmentDataUrl('site-a', '1')).toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(29 * 60_000)
    expect(_getAttachmentImageCacheSize()).toBe(1)
    expect(getCachedAttachmentDataUrl('site-a', '96')).not.toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves the 24 MiB byte limit and releases the remaining images while idle', () => {
    for (let id = 0; id < 13; id += 1) {
      setCachedAttachmentDataUrl({
        siteId: 'site-a',
        attachmentId: String(id),
        dataUrl: `data:image/png;base64,${id}`,
        byteSize: 2 * 1024 * 1024
      })
    }

    expect(_getAttachmentImageCacheSize()).toBe(12)
    expect(getCachedAttachmentDataUrl('site-a', '0')).toBeNull()
    expect(getCachedAttachmentDataUrl('site-a', '1')).not.toBeNull()
    expect(getCachedAttachmentDataUrl('site-a', '12')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(30 * 60_000)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps expiry scheduled for another site after clearing the earliest site', () => {
    storeImage('site-a', 'old')
    vi.advanceTimersByTime(60_000)
    storeImage('site-b', 'new')
    clearAttachmentImagesForSite('site-a')

    expect(_getAttachmentImageCacheSize()).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(29 * 60_000)
    expect(_getAttachmentImageCacheSize()).toBe(1)
    expect(getCachedAttachmentDataUrl('site-b', 'new')).not.toBeNull()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(60_000)
    expect(_getAttachmentImageCacheSize()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
