import type { HostTaskItemReviewOperations } from './host-task-item-review-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskItemReviewOperations(
  _client: RpcClient
): HostTaskItemReviewOperations {
  throw new Error('Hosted Tasks requires explicit item review operations')
}
