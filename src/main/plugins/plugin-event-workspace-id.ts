import { getConnectionExecutionHostId } from '../../shared/execution-host'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  worktreeHostIdentity,
  type WorktreeMetaIdentitySource
} from '../persistence/worktree-meta-host-identity'
import { pluginListedWorkspaceId } from './workers/host-api/plugin-workspace-projection'

/**
 * The `workspaceListId` of an agent's workspace: the id `workspace.list` gives it. The identity
 * comes from the metadata row of the host the agent reported from (`connectionId`: an SSH host,
 * else this machine), never another host's same-id row; without one the raw id stands.
 */
export function pluginAgentWorkspaceListId(
  store: WorktreeMetaIdentitySource | null | undefined,
  worktreeId: string,
  connectionId: string | null | undefined
): string | undefined {
  const { identityKey } =
    parseWorkspaceKey(worktreeId)?.type === 'folder'
      ? {}
      : worktreeHostIdentity(store, worktreeId, getConnectionExecutionHostId(connectionId))
  return pluginListedWorkspaceId({ id: worktreeId, identityKey })
}
