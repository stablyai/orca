import { describe, expect, it } from 'vitest'

import { isRenderableImageUri } from './mobile-native-chat-image-preview'

describe('isRenderableImageUri', () => {
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
