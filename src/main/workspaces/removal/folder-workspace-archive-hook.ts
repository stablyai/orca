import { archiveHookRanFrom } from '../../../shared/worktree/removal/archive-hook-decision'
import { isRepoOnCatalogHost } from '../../../shared/execution-host/execution-host'
import type { WorkspaceHookOwner } from '../../../shared/workspace-setup/hooks/workspace-hook-owner'
import type { Repo } from '../../../shared/repository/repo-types'
import type { ArchiveHookOverride } from '../../../shared/worktree/removal/archive-hook-removal-gate'
import { removeFolderSetupRunnerFiles } from '../../workspace-hooks/folder-setup-runner-files'
import { runHook } from '../../workspace-hooks/hooks'
import { loadArchiveHooksForRemoval } from '../../workspace-hooks/archive-hook-trust-content'
import type { HookRuntimeTarget } from '../../workspace-hooks/hook-runtime-target'
import { gateWorktreeRemovalOnArchiveHook } from './worktree-archive-hook-gate'
import { blockedWslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'

/**
 * Run a folder workspace's archive script before anything is torn down, as worktree removal does.
 * Only the host holding the folder runs it; others own no files there.
 */
export async function gateFolderWorkspaceRemovalOnArchiveHook(args: {
  repo: WorkspaceHookOwner
  worktreeId: string
  displayName: string
  workspacePath?: string
  runArchive: boolean
  allowFailure: boolean
  /** The approved archive version; refused before running if orca.yaml now differs. */
  approvedArchiveHash?: string
  runtimeTarget: () => HookRuntimeTarget | undefined
}): Promise<{ ran: boolean | null; override?: ArchiveHookOverride }> {
  const { repo } = args
  if (!args.runArchive || !isRepoOnCatalogHost(repo)) {
    return { ran: false }
  }
  const hooks = await loadArchiveHooksForRemoval(repo, {
    runHooks: true,
    approvedArchiveHash: args.approvedArchiveHash
  })
  if (!hooks?.scripts.archive) {
    return { ran: false }
  }
  const result = await runHook('archive', repo.path, repo, repo.path, args.runtimeTarget(), {
    identity: {
      worktreeId: args.worktreeId,
      displayName: args.displayName,
      ...(args.workspacePath !== undefined ? { workspacePath: args.workspacePath } : {})
    },
    hooks
  })
  const override = gateWorktreeRemovalOnArchiveHook({
    worktreePath: repo.path,
    result,
    allowFailure: args.allowFailure
  })
  return { ran: archiveHookRanFrom(result), ...(override ? { override } : {}) }
}

/** Runner files are per launch; drop this workspace's once its processes have stopped. */
export function removeFolderWorkspaceRunnerFiles(repo: Repo, worktreeId: string): void {
  if (!isRepoOnCatalogHost(repo)) {
    return
  }
  // A stopped distro keeps its leftover runners rather than starting for cleanup.
  void blockedWslDistroForPath(repo.path)
    .then((blocked) => (blocked ? undefined : removeFolderSetupRunnerFiles(repo.path, worktreeId)))
    .catch((error: unknown) => {
      console.warn(`[hooks] could not clean setup runners in ${repo.path}:`, error)
    })
}
