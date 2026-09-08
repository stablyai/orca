import {
  MobileWebNativeChatPendingReadPayloadSchema,
  MobileWebNativeChatPendingReadResultSchema,
  MobileWebNativeChatPendingWritePayloadSchema
} from '../../../src/shared/mobile-web/bridge-operation-contract'
import type { RpcClient } from '../transport/rpc-client'
import { MobileWebBrokerError } from './mobile-web-broker-error'
import type { MobileWebNativeCapabilityAuthority } from './mobile-web-native-capability-authority'
import type { MobileWebNativeChatAuthority } from './mobile-web-native-chat-authority'
import type { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'
import {
  assertCurrentMobileWebNativeChatBinding,
  resolveMobileWebNativeChatBinding
} from './mobile-web-native-chat-binding'
import {
  executeMobileWebNativeChatImageOperation,
  isMobileWebNativeChatImageOperation
} from './mobile-web-native-chat-image-operations'

export async function executeMobileWebNativeChatOperation(args: {
  operation: string
  payload: unknown
  client: RpcClient
  isActive?: () => boolean
  terminalClientId: string
  workspaceAuthority: MobileWebWorkspaceAuthority
  nativeChatAuthority: MobileWebNativeChatAuthority
  nativeAuthority: Pick<
    MobileWebNativeCapabilityAuthority,
    'sessionChatPendingRead' | 'sessionChatPendingWrite'
  >
}): Promise<unknown> {
  if (isMobileWebNativeChatImageOperation(args.operation)) {
    return executeMobileWebNativeChatImageOperation(args)
  }
  if (args.operation === 'pendingRead') {
    const payload = MobileWebNativeChatPendingReadPayloadSchema.parse(args.payload)
    const binding = await resolveMobileWebNativeChatBinding(
      args,
      payload.workspaceId,
      payload.sessionId
    )
    if (!args.nativeAuthority.sessionChatPendingRead) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    return MobileWebNativeChatPendingReadResultSchema.parse({
      deliveries: await args.nativeAuthority.sessionChatPendingRead(
        binding.hostWorkspaceId,
        binding.hostTabId,
        binding.providerSessionId
      )
    })
  }
  if (args.operation === 'pendingWrite') {
    const payload = MobileWebNativeChatPendingWritePayloadSchema.parse(args.payload)
    const binding = await resolveMobileWebNativeChatBinding(
      args,
      payload.workspaceId,
      payload.sessionId
    )
    if (!args.nativeAuthority.sessionChatPendingWrite) {
      throw new MobileWebBrokerError('unsupported_capability')
    }
    await assertCurrentMobileWebNativeChatBinding(
      args,
      payload.workspaceId,
      payload.sessionId,
      binding
    )
    await args.nativeAuthority.sessionChatPendingWrite(
      binding.hostWorkspaceId,
      binding.hostTabId,
      binding.providerSessionId,
      payload.deliveries
    )
    return null
  }
  throw new MobileWebBrokerError('unsupported_capability')
}
