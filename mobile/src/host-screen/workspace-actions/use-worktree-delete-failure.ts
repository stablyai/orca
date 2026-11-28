import { useCallback, useState } from 'react'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

export type WorktreeDeleteFailure = {
  desktopClient: RpcClient
  item: Worktree
  /** The computer's Orca is too old for this delete from a phone; shown as the shared update toast. */
  hostUpdate: boolean
  message: string
}

type DeleteFailureCause = Error | { code?: string; message: string } | undefined

/** Why a delete left the row in place, or that the host is too old for this delete from a phone. */
function deleteFailureReason(
  cause: DeleteFailureCause
): { hostUpdate: boolean; message: string } | null {
  // A lost reply proves nothing: the host may have deleted it, so its listing decides.
  if (cause === undefined || isRpcDeliveryUnknown(cause)) {
    return null
  }
  const code = cause instanceof Error ? undefined : cause.code
  return isMobileMethodUnavailableError(code, cause.message)
    ? { hostUpdate: true, message: '' }
    : { hostUpdate: false, message: cause.message }
}

/** Desktop's failure toast for a delete: held until dismissed, since a refreshed list proves nothing about why. */
export function useWorktreeDeleteFailure(client: RpcClient | null) {
  const [failure, setFailure] = useState<WorktreeDeleteFailure | null>(null)
  const reportDeleteFailure = useCallback(
    (desktopClient: RpcClient, item: Worktree, cause: DeleteFailureCause) => {
      const reason = deleteFailureReason(cause)
      if (reason !== null) {
        setFailure({ desktopClient, item, ...reason })
      }
    },
    []
  )
  const dismissDeleteFailure = useCallback(() => setFailure(null), [])
  return {
    // It belongs to the desktop it happened on; after a host switch it is gone.
    deleteFailure: failure && failure.desktopClient === client ? failure : null,
    reportDeleteFailure,
    dismissDeleteFailure
  }
}
