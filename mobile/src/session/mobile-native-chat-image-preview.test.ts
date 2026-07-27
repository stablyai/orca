import { describe, expect, it } from 'vitest'
import { isRenderableImageUri } from './mobile-native-chat-image-preview'

describe('isRenderableImageUri', () => {
  it('accepts local previews and real URLs the device can load', () => {
    for (const uri of [
      'file:///var/mobile/a.jpg',
      'data:image/png;base64,AAAA',
      'content://media/1',
      'blob:abc',
      'http://host/a.png',
      'https://host/a.png'
    ]) {
      expect(isRenderableImageUri(uri)).toBe(true)
    }
  })

  it('rejects bare host paths (not loadable on the device) and empty values', () => {
    for (const uri of [
      '/tmp/orca-attach.png',
      'C:\\tmp\\a.png',
      'orca-attach.png',
      '',
      undefined
    ]) {
      expect(isRenderableImageUri(uri)).toBe(false)
    }
  })
})
