import { homedir } from 'node:os'
import { isFloatingWorkspaceSelector } from '../../../../shared/floating-workspace-worktree'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedWorktree } from '../../workspaces/catalog/runtime-worktree-path-identity'
import { readFloatingTerminalCwd } from '../../../ipc/floating-workspace-directory'
import { resolveWorktreeLaunchHost } from '../../workspaces/catalog/worktree-launch-host-repo'
import { resolveCreatedWorktreeTerminalTarget } from './runtime-created-worktree-terminal-target'
import type { ResolvedTerminalWorkspaceLaunchTarget } from './terminal-workspace-launch-target'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'

type TargetHost = {
  store: RuntimeStore | null | undefined
  resolveFolder: (
    selector: string,
    options: { wslUserAct?: boolean },
    folder: FolderWorkspace | undefined,
    check: boolean
  ) => Promise<(TerminalWorkspaceLaunchScope & { folderWorkspace: FolderWorkspace }) | null>
  folderWorktree: (folder: FolderWorkspace) => ResolvedWorktree
  resolveWorktree: (selector: string) => Promise<ResolvedWorktree>
}

export async function resolveTerminalWorkspaceTarget(
  host: TargetHost,
  selector: string,
  createdWorktree?: Worktree,
  options: { wslUserAct?: boolean } = {},
  resolvedWorktree?: ResolvedWorktree,
  resolvedFolder?: FolderWorkspace,
  checkPath = true,
  preparedFloatingPath?: string
): Promise<ResolvedTerminalWorkspaceLaunchTarget> {
  if (isFloatingWorkspaceSelector(selector)) {
    // Why no managed worktree: the floating sentinel has no repo or worktree record behind it.
    return {
      scope: {
        id: FLOATING_TERMINAL_WORKTREE_ID,
        path:
          preparedFloatingPath ??
          (host.store
            ? await readFloatingTerminalCwd(host.store, {
                path: host.store.getSettings().floatingTerminalCwd
              })
            : homedir()),
        connectionId: null,
        repo: null,
        folderWorkspace: null
      },
      managedWorktree: null
    }
  }

  const folderScope = await host.resolveFolder(selector, options, resolvedFolder, checkPath)
  if (folderScope) {
    return {
      scope: folderScope,
      managedWorktree: host.folderWorktree(folderScope.folderWorkspace)
    }
  }

  const workspaceSelector = selector.startsWith('id:') ? selector.slice(3) : selector
  const parsed = parseWorkspaceKey(workspaceSelector)
  const worktreeSelector = parsed?.type === 'worktree' ? `id:${parsed.worktreeId}` : selector
  const worktree =
    resolvedWorktree ??
    resolveCreatedWorktreeTerminalTarget(host.store, selector, createdWorktree) ??
    (await host.resolveWorktree(worktreeSelector))
  // Repo ids are host-blind; resolve the worktree owner or refuse as unresolved rather than spawn locally with a remote cwd (#11163).
  const resolution = resolveWorktreeLaunchHost(host.store?.getRepos() ?? [], worktree)
  if (resolution.kind === 'ambiguous') {
    throw new Error('worktree_execution_host_unresolved')
  }
  // Metadata only (display name, hook settings); the routing decision is `resolution.connectionId`.
  const repo = resolution.repo ?? host.store?.getRepo(worktree.repoId) ?? null
  return {
    scope: {
      id: worktree.id,
      path: worktree.path,
      connectionId: resolution.connectionId,
      repo,
      folderWorkspace: null
    },
    managedWorktree: worktree
  }
}
