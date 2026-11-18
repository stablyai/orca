import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { getLineageGroupKey } from '../../../src/shared/sidebar-list/sections/group-keys'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import { composeWorktreeHostIdentity } from '../../../src/shared/worktree/host-qualified-identity'

/** A bot's fold in the list's collapsed groups, the key the desktop syncs for its home folder. */
export function hostBotFoldKey(hostId: ExecutionHostId, folderWorkspaceId: string): string {
  const homeKey = folderWorkspaceKey(folderWorkspaceId)
  return getLineageGroupKey(
    hostId === LOCAL_EXECUTION_HOST_ID ? homeKey : composeWorktreeHostIdentity(hostId, homeKey)
  )
}
