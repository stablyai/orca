import { expect, it } from 'vitest'
import { nativeChatImageItemBody } from './provider-image-item'

it('keeps a saved generated image when the provider omits its status', () => {
  expect(
    nativeChatImageItemBody({
      id: 'generated-image',
      type: 'imageGeneration',
      savedPath: '/workspace/generated.png'
    }).blocks
  ).toContainEqual({ type: 'image-ref', path: '/workspace/generated.png' })
})
