import type { RuntimeWorktreePsResult } from '../../../shared/runtime-worktree-contracts'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  isWorkspaceOwnedBySomeoneElse
} from '../../../shared/workspace-creator-visibility'
import type { RpcContext } from './core'
import { isHostOwnPhone } from './host-own-phone'

/**
 * Marks the rows this host calls another client's, for its own phone, which applies the shared
 * "Hide other-client workspaces" value itself. A delegated phone belongs to another desktop, whose
 * view this host cannot speak for.
 */
export function markWorktreePsOtherClientRows<T extends RuntimeWorktreePsResult>(
  result: T,
  context: Pick<RpcContext, 'clientKind' | 'pairedDeviceParentId'>
): T {
  if (!isHostOwnPhone(context)) {
    return result
  }
  let marked = false
  const worktrees = result.worktrees.map((row) => {
    if (!isWorkspaceOwnedBySomeoneElse(row, EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT)) {
      return row
    }
    marked = true
    return { ...row, desktopOtherClient: true as const }
  })
  return marked ? { ...result, worktrees } : result
}
