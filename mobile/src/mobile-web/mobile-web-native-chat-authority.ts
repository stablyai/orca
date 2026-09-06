import type { MobileWebHostWorkspaceId } from './mobile-web-workspace-authority'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import { MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT } from '../../../src/shared/mobile-web/native-chat-operation-contract'

export type MobileWebHostNativeChatBinding = {
  hostWorkspaceId: MobileWebHostWorkspaceId
  hostTabId: string
  hostTerminalId: string | null
  agent: string
  providerSessionId: string
  transcriptPath?: string
}

export class MobileWebNativeChatAuthority {
  private readonly sessionIdByHostKey = new Map<string, string>()
  private readonly bindingBySessionId = new Map<string, MobileWebHostNativeChatBinding>()
  private readonly imagesBySessionId = new Map<string, Map<string, string>>()
  private nextHandle = 0
  private nextImageHandle = 0

  constructor(private readonly randomBytes: (length: number) => Uint8Array) {}

  synchronizeWorkspace(
    hostWorkspaceId: string,
    bindings: readonly MobileWebHostNativeChatBinding[]
  ): void {
    const currentKeys = new Set(bindings.map(nativeChatHostKey))
    for (const [hostKey, sessionId] of this.sessionIdByHostKey) {
      const binding = this.bindingBySessionId.get(sessionId)
      if (binding?.hostWorkspaceId === hostWorkspaceId && !currentKeys.has(hostKey)) {
        this.revoke(sessionId)
      }
    }
    bindings.forEach((binding) => this.register(binding))
  }

  register(binding: MobileWebHostNativeChatBinding): string {
    const hostKey = nativeChatHostKey(binding)
    const existing = this.sessionIdByHostKey.get(hostKey)
    if (existing) {
      return existing
    }
    const bytes = this.randomBytes(16)
    if (bytes.byteLength !== 16) {
      throw new MobileWebBrokerError('internal')
    }
    const sessionId = `native_chat_${this.nextHandle.toString(36)}_${Array.from(
      bytes,
      byteToHex
    ).join('')}`
    this.nextHandle += 1
    this.sessionIdByHostKey.set(hostKey, sessionId)
    this.bindingBySessionId.set(sessionId, binding)
    return sessionId
  }

  resolve(hostWorkspaceId: string, sessionId: string): Readonly<MobileWebHostNativeChatBinding> {
    const binding = this.bindingBySessionId.get(sessionId)
    if (!binding || binding.hostWorkspaceId !== hostWorkspaceId) {
      throw new MobileWebBrokerError('not_found')
    }
    return binding
  }

  assertBinding(
    hostWorkspaceId: string,
    sessionId: string,
    expected: Readonly<MobileWebHostNativeChatBinding>
  ): void {
    if (
      nativeChatHostKey(this.resolve(hostWorkspaceId, sessionId)) !== nativeChatHostKey(expected)
    ) {
      throw new MobileWebBrokerError('conflict')
    }
  }

  revoke(sessionId: string): void {
    const binding = this.bindingBySessionId.get(sessionId)
    if (!binding) {
      return
    }
    this.bindingBySessionId.delete(sessionId)
    this.sessionIdByHostKey.delete(nativeChatHostKey(binding))
    this.imagesBySessionId.delete(sessionId)
  }

  registerImage(hostWorkspaceId: string, sessionId: string, hostPath: string): string {
    this.resolve(hostWorkspaceId, sessionId)
    const images = this.imagesBySessionId.get(sessionId) ?? new Map<string, string>()
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
    this.imagesBySessionId.set(sessionId, images)
    return imageId
  }

  resolveImagePaths(
    hostWorkspaceId: string,
    sessionId: string,
    imageIds: readonly string[]
  ): string[] {
    this.resolve(hostWorkspaceId, sessionId)
    const images = this.imagesBySessionId.get(sessionId)
    const paths = imageIds.map((imageId) => images?.get(imageId))
    if (paths.some((path) => !path)) {
      throw new MobileWebBrokerError('not_found')
    }
    return paths as string[]
  }

  releaseImages(hostWorkspaceId: string, sessionId: string, imageIds: readonly string[]): void {
    this.resolve(hostWorkspaceId, sessionId)
    const images = this.imagesBySessionId.get(sessionId)
    if (!images) {
      return
    }
    imageIds.forEach((imageId) => images.delete(imageId))
    if (images.size === 0) {
      this.imagesBySessionId.delete(sessionId)
    }
  }

  clear(): void {
    this.sessionIdByHostKey.clear()
    this.bindingBySessionId.clear()
    this.imagesBySessionId.clear()
  }
}

function nativeChatHostKey(binding: MobileWebHostNativeChatBinding): string {
  return [
    binding.hostWorkspaceId,
    binding.hostTabId,
    binding.hostTerminalId ?? '',
    binding.agent,
    binding.providerSessionId,
    binding.transcriptPath ?? ''
  ]
    .map((value) => `${value.length}:${value}`)
    .join('')
}

function byteToHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}
