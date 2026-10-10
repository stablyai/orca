import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import {
  materializeWorktreePushTargetRemote,
  materializeWorktreePushTargetRemoteSsh
} from '../ipc/worktree-remote'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { GitPushTarget } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { Store } from '../persistence'

// Why (#17828): a fork-PR remote deferred at worktree-create time must exist before an
// autonomous agent's raw git commands run in a freshly opened terminal -- "sync through
// Orca first" isn't an option mid-task. Fires on every terminal spawn into the worktree;
// materialize() is already a no-op once the remote exists, so repeat spawns cost one probe.
// Never awaited by callers: terminal spawn must not block on remote-add/fetch network I/O.
export function triggerTerminalSpawnPushTargetMaterialization(
  worktreePath: string,
  pushTarget: GitPushTarget | undefined,
  repo: Repo | null | undefined,
  store: Store | undefined,
  repoId?: string,
  worktreeId?: string
): void {
  if (!pushTarget?.remoteUrl || pushTarget.remoteCreated) {
    return
  }
  const connectionId = repo?.connectionId ?? undefined
  const materialized = connectionId
    ? materializeOverSsh(connectionId, worktreePath, pushTarget, store, worktreeId)
    : materializeWorktreePushTargetRemote(
        worktreePath,
        pushTarget,
        store,
        repoId,
        localGitOptionsForTerminalSpawn(store, repo),
        worktreeId
      )
  materialized.catch((error: unknown) => {
    console.warn(
      `[terminal-spawn] failed to materialize push target remote for ${worktreePath}:`,
      error
    )
  })
}

function materializeOverSsh(
  connectionId: string,
  worktreePath: string,
  pushTarget: GitPushTarget,
  store: Store | undefined,
  worktreeId: string | undefined
): Promise<GitPushTarget> {
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    // Why: connection dropped -- the next Orca-driven sync action will retry via its own dispatch.
    return Promise.resolve(pushTarget)
  }
  return materializeWorktreePushTargetRemoteSsh(
    provider,
    worktreePath,
    pushTarget,
    store,
    undefined,
    worktreeId
  )
}

function localGitOptionsForTerminalSpawn(
  store: Store | undefined,
  repo: Repo | null | undefined
): { wslDistro?: string } {
  if (!store || !repo) {
    return {}
  }
  try {
    // Why: a WSL-hosted repo's remote add/fetch must run under the same distro as
    // the terminal, or it can target the wrong git binary entirely (repair-required
    // project runtimes throw here -- fall back to host git rather than crash spawn).
    return getLocalProjectWorktreeGitOptions(store, repo)
  } catch (error) {
    console.warn(`[terminal-spawn] failed to resolve local git options for ${repo.path}:`, error)
    return {}
  }
}
