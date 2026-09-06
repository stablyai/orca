import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionFileOperations } from './host-session-file-operations'
import { nativeHostSessionFileOperations } from './native-host-session-file-operations'

export function defaultHostSessionFileOperations(client: RpcClient): HostSessionFileOperations {
  return nativeHostSessionFileOperations(client)
}
