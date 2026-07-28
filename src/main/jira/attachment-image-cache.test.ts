import { beforeEach, describe, expect, it } from 'vitest'
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
    _resetAttachmentImageCache()
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
})
