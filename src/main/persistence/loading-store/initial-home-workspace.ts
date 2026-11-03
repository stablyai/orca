import { homedir } from 'node:os'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { getRepoMainWorktreeId } from '../../../shared/worktree/id'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { createLocalProjectRecord } from '../../workspaces/catalog/local-project-record'
import type { Store } from './store'

export function initializeHomeWorkspace(
  store: Pick<Store, 'addRepo' | 'patchWorkspaceSession'>
): void {
  const home = createLocalProjectRecord({ path: homedir(), kind: 'folder', displayName: 'Home' })
  store.addRepo(home)
  const worktreeId = getRepoMainWorktreeId(home)
  store.patchWorkspaceSession({
    activeRepoId: home.id,
    activeWorktreeId: worktreeId,
    activeWorkspaceKey: worktreeWorkspaceKey(worktreeId),
    activeWorkspaceExecutionHostId: LOCAL_EXECUTION_HOST_ID,
    activeTabId: null
  })
}
