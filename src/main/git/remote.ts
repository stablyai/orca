import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { gitExecFileAsync } from './runner'

export async function gitPush(worktreePath: string, _publish = false): Promise<void> {
  try {
    // Why: always pass --set-upstream so that worktrees Orca creates with
    // `git worktree add --track -b <name> <dir> <baseRef>` (which initially
    // track the BASE — e.g. origin/main) get their upstream repointed to
    // origin/<branch> on first push. Without this the local branch keeps
    // tracking origin/main forever, so ahead/behind reads via @{u} measure
    // "ahead of base" rather than "ahead of remote branch", and the primary
    // button never rotates from "Push" to "Commit" after a successful push.
    //
    // The `publish` flag becomes redundant under this strategy — every push
    // sets upstream, including the first. We keep the parameter in the
    // signature so callers don't need to change, but it's no longer
    // load-bearing. On an already-published branch --set-upstream is a
    // no-op for the tracking config and a regular push otherwise.
    //
    // Branch-vs-base reporting (the "Committed on Branch" section) is
    // unaffected because it uses branchCompare against an explicit baseRef
    // from worktree config, not the upstream relationship.
    await gitExecFileAsync(['push', '--set-upstream', 'origin', 'HEAD'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'push'))
  }
}

export async function gitPull(worktreePath: string): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  try {
    await gitExecFileAsync(['pull'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'pull'))
  }
}

export async function gitFetch(worktreePath: string): Promise<void> {
  try {
    await gitExecFileAsync(['fetch', '--prune'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error, 'fetch'))
  }
}
