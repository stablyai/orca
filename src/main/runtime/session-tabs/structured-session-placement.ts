import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem, worktreeIdsEqual } from '../../../shared/worktree/id'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeStore } from '../runtime-store-contract'

function workspaceRegistered(store: RuntimeStore, workspaceId: string): boolean {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    return !!store.getFolderWorkspaces?.().some((row) => row.id === scope.folderWorkspaceId)
  }
  const repoId = splitWorktreeIdForFilesystem(workspaceId)?.repoId
  return store
    .getRepos()
    .some((repo) => repo.id === repoId && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID)
}

/** A readable local chat whose own workspace is registered shows only there; anything unproven keeps its row. */
export function structuredSessionPlacementAllowed(
  store: RuntimeStore | null | undefined,
  workspaceId: string,
  sessionId: string
): boolean {
  const location = getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.location
  return (
    !store ||
    !location ||
    location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    worktreeIdsEqual(location.workspaceId, workspaceId) ||
    !workspaceRegistered(store, location.workspaceId)
  )
}
