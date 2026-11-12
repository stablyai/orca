import type { OrcaHooks } from '../../../shared/orca-yaml-hook-types'
import { isRepoOnCatalogHost } from '../../../shared/execution-host'
import type { WorkspaceHookOwner } from '../../../shared/workspace-hook-owner'
import type { ArchiveHookOverride } from '../../../shared/worktree/archive-hook-removal-gate'
import { removeFolderSetupRunnerFiles } from '../../workspace-hooks/folder-setup-runner-files'
import { getEffectiveHooks, runHook } from '../../workspace-hooks/hooks'
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
  hooks?: OrcaHooks | null
  runArchive: boolean
  allowFailure: boolean
  runtimeTarget: () => HookRuntimeTarget | undefined
}): Promise<ArchiveHookOverride | undefined> {
  const { repo } = args
  if (!args.runArchive || !isRepoOnCatalogHost(repo)) {
    return undefined
  }
  const hooks = args.hooks === undefined ? getEffectiveHooks(repo) : args.hooks
  if (!hooks?.scripts.archive) {
    return undefined
  }
  const result = await runHook('archive', repo.path, repo, repo.path, args.runtimeTarget(), {
    identity: {
      worktreeId: args.worktreeId,
      displayName: args.displayName,
      workspacePath: args.workspacePath
    },
    hooks
  })
  return gateWorktreeRemovalOnArchiveHook({
    worktreePath: repo.path,
    result,
    allowFailure: args.allowFailure
  })
}

/** Runner files are per launch; drop this workspace's once its processes have stopped. */
export function removeFolderWorkspaceRunnerFiles(
  repo: WorkspaceHookOwner,
  worktreeId: string
): void {
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
