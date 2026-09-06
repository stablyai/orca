import type { HostTaskLinearOperations } from './host-task-linear-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskLinearOperations(_client: RpcClient): HostTaskLinearOperations {
  throw new Error('Hosted Tasks requires explicit Linear operations')
}
