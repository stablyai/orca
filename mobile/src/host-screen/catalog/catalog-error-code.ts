import { isHostNotConnectedError } from '../../query/host-query-errors'
import { WorktreeCatalogReadError } from '../../worktree/catalog/worktree-catalog-snapshot-client'
import { RpcIncompatibleReplyError } from '../../transport/rpc/rpc-incompatible-reply-error'

// Shown verbatim so broken remote hosts stay diagnosable instead of looking empty (STA-3123).
export function catalogErrorCode(error: unknown): string | null {
  if (isHostNotConnectedError(error)) {
    return null
  }
  if (error instanceof WorktreeCatalogReadError) {
    return error.code
  }
  return error instanceof RpcIncompatibleReplyError ? 'invalid_response' : 'network_error'
}
