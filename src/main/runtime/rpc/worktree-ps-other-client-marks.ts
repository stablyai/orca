import type { RuntimeWorktreePsResult } from '../../../shared/runtime-worktree-contracts'
import {
  EMPTY_PAIRED_DEVICE_IDS_BY_ENVIRONMENT,
  isWorkspaceOwnedBySomeoneElse
} from '../../../shared/workspace-creator-visibility'
import type { RpcContext } from './core'
import { isHostOwnPhone } from './host-own-phone'

/** Mark ownership for this host's phone to apply its filter; delegated phones belong to another desktop whose view this host cannot infer. */
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
