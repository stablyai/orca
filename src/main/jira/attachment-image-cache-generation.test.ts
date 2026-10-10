import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetAttachmentImageCache,
  clearAttachmentImagesForSite,
  getCachedAttachmentDataUrl,
  loadAttachmentDataUrlWithCache
} from './attachment-image-cache'

type Image = { dataUrl: string; byteSize: number } | null
function deferredImage() {
  let resolve!: (image: Image) => void
  let reject!: (error: Error) => void
  const promise = new Promise<Image>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(_resetAttachmentImageCache)

describe.each(['site', 'all'] as const)('attachment download after clearing %s', (scope) => {
  it.each(['success', 'empty', 'failure'] as const)(
    'keeps the replacement singleflight when the old download completes with %s',
    async (outcome) => {
      const old = deferredImage()
      const replacement = deferredImage()
      let downloads = 0
      const load = () => {
        downloads += 1
        return downloads === 1 ? old.promise : replacement.promise
      }
      const args = { siteId: 'site-a', attachmentId: 'image-1', load }
      const first = loadAttachmentDataUrlWithCache(args).catch(() => 'old failure')
      clearAttachmentImagesForSite(scope === 'site' ? 'site-a' : undefined)
      const second = loadAttachmentDataUrlWithCache(args)
      expect(downloads).toBe(2)

      if (outcome === 'failure') {
        old.reject(new Error('old failure'))
      } else {
        old.resolve(outcome === 'empty' ? null : { dataUrl: 'old image', byteSize: 3 })
      }
      expect(await first).toBe(
        outcome === 'failure' ? 'old failure' : outcome === 'empty' ? null : 'old image'
      )
      expect(getCachedAttachmentDataUrl('site-a', 'image-1')).toBeNull()

      const third = loadAttachmentDataUrlWithCache(args)
      expect(downloads).toBe(2)
      replacement.resolve({ dataUrl: 'new image', byteSize: 3 })
      expect(await second).toBe('new image')
      expect(await third).toBe('new image')
      expect(getCachedAttachmentDataUrl('site-a', 'image-1')).toBe('new image')
    }
  )
})
