import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT } from '../../../src/shared/mobile-web/native-chat-operation-contract'
import { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'

describe('mobile web native chat image authority', () => {
  it('keeps staged image paths opaque and scoped to one workspace session', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length).fill(9))
    const imageId = authority.registerImage('workspace-a', 'session-a', '/private/image.png')

    expect(imageId).toMatch(/^native_chat_image_0_[a-f0-9]{32}$/)
    expect(imageId).not.toContain('private')
    expect(authority.resolveImagePaths('workspace-a', 'session-a', [imageId])).toEqual([
      '/private/image.png'
    ])
    expect(() => authority.resolveImagePaths('workspace-a', 'session-b', [imageId])).toThrow(
      'not_found'
    )
    expect(() => authority.resolveImagePaths('workspace-b', 'session-a', [imageId])).toThrow(
      'not_found'
    )
  })

  it('does not confuse sessions whose workspace and session ids concatenate alike', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const imageId = authority.registerImage('workspace', 'a-session', '/private/image.png')

    expect(() => authority.resolveImagePaths('workspacea', '-session', [imageId])).toThrow(
      'not_found'
    )
  })

  it('bounds and releases session image references', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const imageIds = Array.from({ length: MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT }, (_, index) =>
      authority.registerImage('workspace-a', 'session-a', `/private/image-${index}.png`)
    )

    expect(() =>
      authority.registerImage('workspace-a', 'session-a', '/private/overflow.png')
    ).toThrow('rate_limited')
    authority.releaseImages('workspace-a', 'session-a', [imageIds[0]!])
    expect(() => authority.resolveImagePaths('workspace-a', 'session-a', [imageIds[0]!])).toThrow(
      'not_found'
    )
    expect(authority.registerImage('workspace-a', 'session-a', '/private/replacement.png')).toMatch(
      /^native_chat_image_/
    )
  })

  it('evicts the oldest session rather than growing without bound', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const first = authority.registerImage('workspace-a', 'session-0', '/private/image-0.png')
    for (let index = 1; index <= 64; index++) {
      authority.registerImage('workspace-a', `session-${index}`, `/private/image-${index}.png`)
    }

    expect(() => authority.resolveImagePaths('workspace-a', 'session-0', [first])).toThrow(
      'not_found'
    )
    expect(authority.resolveImagePaths('workspace-a', 'session-64', [])).toEqual([])
  })

  it('clears every staged image on shell or client replacement', () => {
    const authority = new MobileWebNativeChatAuthority((length) => new Uint8Array(length))
    const imageId = authority.registerImage('workspace-a', 'session-a', '/private/image.png')

    authority.clear()

    expect(() => authority.resolveImagePaths('workspace-a', 'session-a', [imageId])).toThrow(
      'not_found'
    )
  })
})
