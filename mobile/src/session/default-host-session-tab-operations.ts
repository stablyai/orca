import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTabOperations } from './host-session-tab-operations'
import { nativeHostSessionTabOperations } from './native-host-session-tab-operations'

export function defaultHostSessionTabOperations(client: RpcClient): HostSessionTabOperations {
  return nativeHostSessionTabOperations(client)
}
