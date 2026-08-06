import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileDiffReviewQueueFilter } from './mobile-diff-review-queue'
import type { MobileDiffReviewInitialTarget } from './mobile-diff-review-positioning'

export type MobileDiffReviewControllerInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  name: string
  initialFilter: MobileDiffReviewQueueFilter
  initialTarget: MobileDiffReviewInitialTarget | null
  onOpenSession: () => void
  onReconnect: (hostId: string) => void | Promise<void>
}
