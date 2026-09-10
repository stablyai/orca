import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionOperations } from './host-session-operations'
import { nativeHostSessionOperations } from './native-host-session-operations'

export function defaultHostSessionOperations(client: RpcClient): HostSessionOperations {
  return nativeHostSessionOperations(client)
}
