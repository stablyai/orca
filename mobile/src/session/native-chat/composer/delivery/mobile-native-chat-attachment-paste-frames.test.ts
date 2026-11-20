import { describe, expect, it } from 'vitest'
import { framedAttachmentPastes } from './mobile-native-chat-image-send'

describe('framedAttachmentPastes', () => {
  it('keeps a space after each file path so two files never run together, but not after an image chip', () => {
    const [json, rtf, png] = framedAttachmentPastes('claude', [
      '/store/a/session.json',
      '/store/b/song.rtf',
      '/store/c/shot.png'
    ])
    expect(json?.endsWith(' ')).toBe(true)
    expect(rtf?.endsWith(' ')).toBe(true)
    expect(png?.endsWith(' ')).toBe(false)
  })
})
