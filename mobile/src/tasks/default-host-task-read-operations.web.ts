import type { HostTaskReadOperations } from './host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskReadOperations(_client: RpcClient): HostTaskReadOperations {
  throw new Error('Hosted Tasks requires explicit task read operations')
}
