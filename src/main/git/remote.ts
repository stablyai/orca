import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { gitExecFileAsync } from './runner'

export async function gitPush(worktreePath: string, publish = false): Promise<void> {
  try {
    // Why: explicit `origin HEAD` refspec works regardless of push.default
    // (which is `simple` by default in modern git). Worktree branches that
    // Orca creates with `git worktree add --track -b <name> <dir> <baseRef>`
    // track the *base* (e.g. origin/main) so the UI can compute ahead/behind
    // against that base. Bare `git push` then fails with "fatal: The upstream
    // branch of your current branch does not match the name of your current
    // branch" because the upstream branch name (main) differs from the local
    // branch name. Pushing to `origin HEAD` publishes the current branch to a
    // same-named remote ref and never trips push.default's match check.
    const args = publish ? ['push', '--set-upstream', 'origin', 'HEAD'] : ['push', 'origin', 'HEAD']
    await gitExecFileAsync(args, { cwd: worktreePath })
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
