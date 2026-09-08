import { MobileWebBrokerError } from './mobile-web-broker-error'
import { MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT } from '../../../src/shared/mobile-web/native-chat-operation-contract'

// Staged image paths are native state the page must never see, so they stay behind opaque
// references. Bounded per session and across sessions so a long-lived shell cannot grow forever.
const IMAGE_SESSION_LIMIT = 64

export class MobileWebNativeChatAuthority {
  private readonly imagesBySession = new Map<string, Map<string, string>>()
  private nextImageHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  registerImage(hostWorkspaceId: string, sessionId: string, hostPath: string): string {
    const key = sessionKey(hostWorkspaceId, sessionId)
    const images = this.imagesBySession.get(key) ?? new Map<string, string>()
    if (images.size >= MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT) {
      throw new MobileWebBrokerError('rate_limited')
    }
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const imageId = `native_chat_image_${this.nextImageHandle.toString(36)}_${Array.from(
      bytes,
      byteToHex
    ).join('')}`
    this.nextImageHandle += 1
    images.set(imageId, hostPath)
    this.evictOldestSessionIfFull(key)
    this.imagesBySession.set(key, images)
    return imageId
  }

  resolveImagePaths(
    hostWorkspaceId: string,
    sessionId: string,
    imageIds: readonly string[]
  ): string[] {
    const images = this.imagesBySession.get(sessionKey(hostWorkspaceId, sessionId))
    const paths = imageIds.map((imageId) => images?.get(imageId))
    if (paths.some((path) => !path)) {
      throw new MobileWebBrokerError('not_found')
    }
    return paths as string[]
  }

  releaseImages(hostWorkspaceId: string, sessionId: string, imageIds: readonly string[]): void {
    const key = sessionKey(hostWorkspaceId, sessionId)
    const images = this.imagesBySession.get(key)
    if (!images) {
      return
    }
    imageIds.forEach((imageId) => images.delete(imageId))
    if (images.size === 0) {
      this.imagesBySession.delete(key)
    }
  }

  clear(): void {
    this.imagesBySession.clear()
  }

  private evictOldestSessionIfFull(key: string): void {
    if (this.imagesBySession.has(key) || this.imagesBySession.size < IMAGE_SESSION_LIMIT) {
      return
    }
    const oldest = this.imagesBySession.keys().next()
    if (!oldest.done) {
      this.imagesBySession.delete(oldest.value)
    }
  }
}

function sessionKey(hostWorkspaceId: string, sessionId: string): string {
  return `${hostWorkspaceId.length}:${hostWorkspaceId}${sessionId}`
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
