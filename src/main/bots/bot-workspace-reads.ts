import type { Repo } from '../../shared/repository/repo-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host/execution-host'
import { parseWslUncPath } from '../../shared/file-access/wsl-paths'
import {
  createScopedWorktreeReads,
  type ScopedWorktreeReads
} from '../runtime/workspaces/catalog/scoped-worktree-row-resolution'
import {
  localWorktreePathPresence,
  type LocalWorktreePathPresence
} from '../workspaces/catalog/local-worktree-path-presence'

/** One batch's repo reads and path probes, shared by every workspace it reads. */
export type BotWorkspaceReads = {
  worktrees: ScopedWorktreeReads
  paths: Map<string, Promise<LocalWorktreePathPresence>>
}

export function createBotWorkspaceReads(): BotWorkspaceReads {
  return { worktrees: createScopedWorktreeReads(), paths: new Map() }
}

function pathPresence(
  pathValue: string,
  reads: BotWorkspaceReads | undefined
): Promise<LocalWorktreePathPresence> {
  let presence = reads?.paths.get(pathValue)
  if (!presence) {
    presence = localWorktreePathPresence(pathValue)
    reads?.paths.set(pathValue, presence)
  }
  return presence
}

/** Only this machine's own disk proves a deletion, with the repository still there: an SSH host,
 *  a stopped WSL distro, an unmounted drive or an unreadable path proves nothing. */
export async function localWorktreeProvenGone(
  repo: Repo,
  worktreePath: string,
  reads?: BotWorkspaceReads
): Promise<boolean> {
  if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID || parseWslUncPath(worktreePath)) {
    return false
  }
  const [repoPresence, worktreePresence] = await Promise.all([
    pathPresence(repo.path, reads),
    pathPresence(worktreePath, reads)
  ])
  return (
    (repoPresence === 'directory' || repoPresence === 'other') && worktreePresence === 'missing'
  )
}
