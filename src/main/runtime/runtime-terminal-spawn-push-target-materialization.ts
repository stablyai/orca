import { materializeWorktreePushTargetRemote } from '../ipc/worktree-remote'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { WorktreePushTargetStore } from '../ipc/worktree-push-target-cleanup'
import type { ProjectRuntimeResolutionStore } from '../local-project-runtime-resolution'

type TerminalPushTargetStore = WorktreePushTargetStore & ProjectRuntimeResolutionStore

// Materialize deferred fork remotes before autonomous agent Git use (#17828); existing remotes cost one probe per spawn.
// Fire-and-forget so terminal startup never waits for remote add/fetch.
export function triggerTerminalSpawnPushTargetMaterialization(
  worktreePath: string,
  pushTarget: GitPushTarget | undefined,
  repo: Repo | null | undefined,
  store: TerminalPushTargetStore | null | undefined,
  repoId?: string,
  worktreeId?: string
): void {
  // A server's own `runtime:` stamp runs here too; only an `ssh:` row's git runs elsewhere.
  const hostId = repo ? getRepoExecutionHostId(repo) : LOCAL_EXECUTION_HOST_ID
  if (
    !pushTarget?.remoteUrl ||
    pushTarget.remoteCreated ||
    (repo && getRepoRoutingConnectionId(repo))
  ) {
    return
  }
  materializeWorktreePushTargetRemote(
    worktreePath,
    pushTarget,
    store,
    repoId,
    localGitOptionsForTerminalSpawn(store, repo),
    worktreeId ? hostWorktreeTarget({ id: worktreeId, hostId }) : undefined
  ).catch((error: unknown) => {
    console.warn(
      `[terminal-spawn] failed to materialize push target remote for ${worktreePath}:`,
      error
    )
  })
}

function localGitOptionsForTerminalSpawn(
  store: ProjectRuntimeResolutionStore | null | undefined,
  repo: Repo | null | undefined
): { wslDistro?: string } {
  if (!store || !repo) {
    return {}
  }
  try {
    // Use the terminal's WSL distro for remote mutation; repair-required runtime failures fall back to host Git rather than crash spawn.
    return getLocalProjectWorktreeGitOptions(store, repo)
  } catch (error) {
    console.warn(`[terminal-spawn] failed to resolve local git options for ${repo.path}:`, error)
    return {}
  }
}
