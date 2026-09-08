import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionMarkdownOperations } from './host-session-markdown-operations'
import { nativeHostSessionMarkdownOperations } from './native-host-session-markdown-operations'

export function defaultHostSessionMarkdownOperations(
  client: RpcClient,
  hostId: string
): HostSessionMarkdownOperations {
  return nativeHostSessionMarkdownOperations(client, hostId)
}
