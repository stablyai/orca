import type { RpcClient } from '../transport/rpc-client'
import type { HostAccountsOperations } from './host-accounts-operations'
import { nativeHostAccountsOperations } from './native-host-accounts-operations'

export function defaultHostAccountsOperations(
  client: RpcClient,
  hostId: string
): HostAccountsOperations {
  return nativeHostAccountsOperations(client, hostId)
}
