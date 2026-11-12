import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import {
  removedWorktreeIdentityKey,
  worktreeMetaIdentityKey
} from '../persistence/removed-worktree-identities'
import { pluginListedWorkspaceId } from './workers/host-api/plugin-workspace-projection'

export type PluginWorktreeMetaSource = {
  getWorktreeMeta(worktreeId: string): Pick<WorktreeMeta, 'instanceId' | 'hostId'> | undefined
}

/**
 * The `workspaceListId` an event carries for a raw worktree id: the id `workspace.list` gives it.
 * A removed worktree's row is already gone, so its identity comes from the removal; without one
 * the raw id stands, as it does in `workspace.list`.
 */
export function pluginEventWorkspaceListId(
  store: PluginWorktreeMetaSource | null | undefined,
  worktreeId: string,
  options: { removed?: boolean } = {}
): string | undefined {
  const identityKey = options.removed
    ? removedWorktreeIdentityKey(worktreeId)
    : worktreeMetaIdentityKey(worktreeId, store?.getWorktreeMeta(worktreeId))
  return pluginListedWorkspaceId({ id: worktreeId, identityKey })
}
