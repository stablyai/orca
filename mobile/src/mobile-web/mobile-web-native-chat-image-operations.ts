import {
  MobileWebNativeChatAttachImagePayloadSchema,
  MobileWebNativeChatAttachImageResultSchema,
  MobileWebNativeChatPasteImagesPayloadSchema,
  MobileWebNativeChatPasteImagesResultSchema,
  MobileWebNativeChatReleaseImagesPayloadSchema
} from '../../../src/shared/mobile-web/native-chat-image-operation-contract'
import { pasteMobileNativeChatImagePaths } from '../session/mobile-native-chat-image-send'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import {
  assertCurrentMobileWebNativeChatPageBinding,
  resolveFreshMobileWebNativeChatPageBinding
} from './mobile-web-native-chat-binding'
import { validateMobileWebNativeChatDeadline } from './mobile-web-native-chat-deadline'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

const IMAGE_OPERATIONS = new Set(['attachImage', 'pasteImages', 'releaseImages'])

export function isMobileWebNativeChatImageOperation(operation: string): boolean {
  return IMAGE_OPERATIONS.has(operation)
}

export async function executeMobileWebNativeChatImageOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  terminalClientId: string
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeChatAuthority: MobileWebNativeChatAuthority
}): Promise<unknown> {
  if (args.operation === 'attachImage') {
    const payload = MobileWebNativeChatAttachImagePayloadSchema.parse(args.payload)
    const binding = await resolveFreshMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId,
      true
    )
    const { prepareMobileWebNativeChatImageAttachment } =
      await import('./mobile-web-terminal-device-input-authority')
    const prepared = await prepareMobileWebNativeChatImageAttachment({
      client: args.client,
      hostWorkspaceId: binding.hostWorkspaceId,
      source: payload.source
    })
    if (prepared.status !== 'accepted') {
      return MobileWebNativeChatAttachImageResultSchema.parse({ status: prepared.status })
    }
    assertCurrentMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId,
      binding
    )
    return MobileWebNativeChatAttachImageResultSchema.parse({
      status: 'accepted',
      attachment: {
        reference: args.nativeChatAuthority.registerImage(
          binding.hostWorkspaceId,
          payload.sessionId,
          prepared.hostPath
        ),
        previewUri: prepared.previewUri
      }
    })
  }
  if (args.operation === 'pasteImages') {
    const payload = MobileWebNativeChatPasteImagesPayloadSchema.parse(args.payload)
    validateMobileWebNativeChatDeadline(payload.deadline)
    const binding = await resolveFreshMobileWebNativeChatPageBinding(
      args,
      payload.workspaceId,
      payload.sessionId,
      true
    )
    const imagePaths = args.nativeChatAuthority.resolveImagePaths(
      binding.hostWorkspaceId,
      payload.sessionId,
      payload.references
    )
    return MobileWebNativeChatPasteImagesResultSchema.parse({
      pasted: await pasteMobileNativeChatImagePaths({
        client: args.client,
        terminal: binding.hostTerminalId!,
        deviceToken: args.terminalClientId,
        imagePaths,
        followedByText: payload.followedByText === true,
        deadline: payload.deadline,
        assertCurrent: () =>
          assertCurrentMobileWebNativeChatPageBinding(
            args,
            payload.workspaceId,
            payload.sessionId,
            binding
          )
      })
    })
  }
  if (args.operation === 'releaseImages') {
    const payload = MobileWebNativeChatReleaseImagesPayloadSchema.parse(args.payload)
    const hostWorkspaceId = args.workspaceAuthority.hostWorkspaceId(payload.workspaceId)
    args.nativeChatAuthority.releaseImages(hostWorkspaceId, payload.sessionId, payload.references)
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
