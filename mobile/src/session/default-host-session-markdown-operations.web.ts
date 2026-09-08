import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionMarkdownOperations } from './host-session-markdown-operations'

export function defaultHostSessionMarkdownOperations(
  _client: RpcClient,
  _hostId: string
): HostSessionMarkdownOperations | null {
  return null
}
