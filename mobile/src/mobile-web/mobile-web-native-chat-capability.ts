import type { MobileWebBridgePageMessage } from '../../../src/shared/mobile-web/bridge-contract'
import type { MobileWebCapabilityExecutionDependencies } from './mobile-web-capability-execution-dependencies'
import { executeMobileWebNativeChatOperation } from './mobile-web-native-chat-operations'

type PageRequest = Extract<MobileWebBridgePageMessage, { type: 'request' }>

export async function executeMobileWebNativeChatCapability(
  args: MobileWebCapabilityExecutionDependencies,
  request: PageRequest
): Promise<unknown> {
  if (request.mode === 'once') {
    return executeMobileWebNativeChatOperation({
      operation: request.operation,
      payload: request.payload,
      client: args.connectedClient(),
      terminalClientId: args.terminalClientId,
      workspaceAuthority: args.workspaceAuthority,
      nativeChatAuthority: args.nativeChatAuthority,
      nativeAuthority: args.nativeAuthority
    })
  }
  if (request.operation === 'subscribe') {
    await args.nativeChatSubscriptions.start({
      requestId: request.requestId,
      subscriptionId: request.subscriptionId,
      payload: request.payload,
      client: args.connectedClient(),
      isRequestActive: args.isRequestActive
    })
    return null
  }
  throw new Error('unsupported_native_chat_request')
}
