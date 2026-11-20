import { useCallback, useState } from 'react'
import { translate } from '../../i18n/mobile-i18n'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import { isRpcDeliveryUnknown } from '../../transport/rpc/rpc-delivery-ambiguity'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'

export type WorktreeDeleteFailure = { desktopClient: RpcClient; item: Worktree; message: string }

type DeleteFailureCause = Error | { code?: string; message: string } | undefined

/** Why a delete left the row in place; a host too old for this delete from a phone says to update. */
function deleteFailureReason(cause: DeleteFailureCause): string | null {
  // A lost reply proves nothing: the host may have deleted it, so its listing decides.
  if (cause === undefined || isRpcDeliveryUnknown(cause)) {
    return null
  }
  const code = cause instanceof Error ? undefined : cause.code
  return isMobileMethodUnavailableError(code, cause.message)
    ? translate(
        'hostScreen.deleteConfirm.needsUpdate',
        'Update Orca on your computer to delete this workspace from your phone.'
      )
    : cause.message
}

/** Desktop's failure toast for a delete: held until dismissed, since a refreshed list proves nothing about why. */
export function useWorktreeDeleteFailure(client: RpcClient | null) {
  const [failure, setFailure] = useState<WorktreeDeleteFailure | null>(null)
  const reportDeleteFailure = useCallback(
    (desktopClient: RpcClient, item: Worktree, cause: DeleteFailureCause) => {
      const message = deleteFailureReason(cause)
      if (message !== null) {
        setFailure({ desktopClient, item, message })
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
