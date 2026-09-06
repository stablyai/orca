import type { HostTaskPreferenceOperations } from './host-task-preference-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskPreferenceOperations(
  _client: RpcClient
): HostTaskPreferenceOperations {
  throw new Error('Hosted Tasks requires explicit task preference operations')
}
