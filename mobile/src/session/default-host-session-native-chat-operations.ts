import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'
import { nativeHostSessionNativeChatOperations } from './native-host-session-native-chat-operations'

export function defaultHostSessionNativeChatOperations(
  client: RpcClient
): HostSessionNativeChatOperations {
  return nativeHostSessionNativeChatOperations(client)
}
