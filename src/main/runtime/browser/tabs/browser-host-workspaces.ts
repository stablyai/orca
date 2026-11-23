import {
  remoteCliBrowserScopeWorkspaceId,
  resolveRemoteCliBrowserScopeSelector
} from '../../desktop-browser-bridge/remote-cli-browser-scope'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { WORKSPACE_SELECTOR_NOT_FOUND } from '../../workspaces/catalog/workspace-selector-candidates'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { rendersBrowserPagesIn } from './browser-tab-listing'

/** Peers stream the pages this window publishes, including ones in workspaces another runtime owns. */
export function resolveBrowserHostWorkspaceSelector<T extends { id: string }>(
  selector: string,
  resolve: (selector: string) => Promise<T>,
  snapshots: ReadonlyMap<string, RuntimeMobileSessionTabsSnapshot>
): Promise<T | { id: string }> {
  return (
    resolveRemoteCliBrowserScopeSelector(selector) ??
    resolve(selector).catch((error: unknown) => {
      const id = selector.startsWith('id:') ? selector.slice(3) : null
      if (
        id &&
        error instanceof Error &&
        error.message === WORKSPACE_SELECTOR_NOT_FOUND &&
        rendersBrowserPagesIn(snapshots.get(id))
      ) {
        return { id }
      }
      throw error
    })
  )
}

/** This runtime's own workspaces, plus the one an SSH host's bridged command is scoped to. */
export function ownsBrowserTabBarWorkspace(
  store: Pick<RuntimeStore, 'getRepos' | 'getFolderWorkspaces'> | null | undefined,
  id: string
): boolean {
  // Why: an SSH host's bridged workspace may have no row here, yet its pages render in this window.
  if (id === remoteCliBrowserScopeWorkspaceId()) {
    return true
  }
  const scope = parseWorkspaceKey(id)
  return scope?.type === 'folder'
    ? (store?.getFolderWorkspaces?.() ?? []).some(
        (workspace) => workspace.id === scope.folderWorkspaceId
      )
    : (store?.getRepos() ?? []).some((repo) => repo.id === getRepoIdFromWorktreeId(id))
}
