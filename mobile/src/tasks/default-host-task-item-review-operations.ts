import type { HostTaskItemReviewOperations } from './host-task-item-review-operations'
import { nativeHostTaskItemReviewOperations } from './native-host-task-item-review-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskItemReviewOperations(
  client: RpcClient
): HostTaskItemReviewOperations {
  return nativeHostTaskItemReviewOperations(client)
}
