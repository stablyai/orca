import type { RpcClient } from '../transport/rpc-client'
import type { HostAccountsOperations } from './host-accounts-operations'

export function defaultHostAccountsOperations(
  _client: RpcClient,
  _hostId: string
): HostAccountsOperations | null {
  return null
}
