import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasMobileClipboardImagePath,
  MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES,
  MOBILE_CLIPBOARD_IMAGE_PROVENANCE_TTL_MS,
  mobileClipboardImageProvenanceSizeForTest,
  recordMobileClipboardImagePath,
  resetMobileClipboardImageProvenanceForTest
} from './mobile-clipboard-image-provenance'

describe('mobile clipboard image provenance', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    resetMobileClipboardImageProvenanceForTest()
  })

  afterEach(() => {
    resetMobileClipboardImageProvenanceForTest()
    vi.useRealTimers()
  })

  it('expires records without consuming them on repeated checks', () => {
    recordMobileClipboardImagePath('device-a', '/tmp/image.png')

    expect(hasMobileClipboardImagePath('device-a', '/tmp/image.png')).toBe(true)
    expect(hasMobileClipboardImagePath('device-a', '/tmp/image.png')).toBe(true)
    vi.advanceTimersByTime(MOBILE_CLIPBOARD_IMAGE_PROVENANCE_TTL_MS + 1)
    expect(hasMobileClipboardImagePath('device-a', '/tmp/image.png')).toBe(false)
    expect(mobileClipboardImageProvenanceSizeForTest()).toBe(0)
  })

  it('evicts the oldest record at the global bound and supports test cleanup', () => {
    for (let index = 0; index <= MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES; index++) {
      recordMobileClipboardImagePath(`device-${index}`, `/tmp/image-${index}.png`)
      vi.advanceTimersByTime(1)
    }

    expect(mobileClipboardImageProvenanceSizeForTest()).toBe(
      MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES
    )
    expect(hasMobileClipboardImagePath('device-0', '/tmp/image-0.png')).toBe(false)
    expect(
      hasMobileClipboardImagePath(
        `device-${MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES}`,
        `/tmp/image-${MOBILE_CLIPBOARD_IMAGE_PROVENANCE_MAX_ENTRIES}.png`
      )
    ).toBe(true)

    resetMobileClipboardImageProvenanceForTest()
    expect(mobileClipboardImageProvenanceSizeForTest()).toBe(0)
  })
})
