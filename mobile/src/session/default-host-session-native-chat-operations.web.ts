import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionNativeChatOperations } from './host-session-native-chat-operations'

export function defaultHostSessionNativeChatOperations(
  _client: RpcClient
): HostSessionNativeChatOperations | null {
  return null
}
