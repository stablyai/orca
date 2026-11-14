import { isRepoOnCatalogHost } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { ArchiveHookOverride } from '../../../shared/worktree/removal/archive-hook-removal-gate'
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
  repo: Repo
  worktreeId: string
  displayName: string
  runArchive: boolean
  allowFailure: boolean
  runtimeTarget: () => HookRuntimeTarget | undefined
}): Promise<ArchiveHookOverride | undefined> {
  const { repo } = args
  if (!args.runArchive || !isRepoOnCatalogHost(repo)) {
    return undefined
  }
  const hooks = getEffectiveHooks(repo)
  if (!hooks?.scripts.archive) {
    return undefined
  }
  const result = await runHook('archive', repo.path, repo, repo.path, args.runtimeTarget(), {
    identity: { worktreeId: args.worktreeId, displayName: args.displayName },
    hooks
  })
  return gateWorktreeRemovalOnArchiveHook({
    worktreePath: repo.path,
    result,
    allowFailure: args.allowFailure
  })
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
