import { normalizeGitErrorMessage } from '../../shared/git-remote-error'
import { gitExecFileAsync } from './runner'

export async function gitPush(worktreePath: string, publish = false): Promise<void> {
  try {
    const args = publish ? ['push', '--set-upstream', 'origin', 'HEAD'] : ['push']
    await gitExecFileAsync(args, { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error))
  }
}

export async function gitPull(worktreePath: string): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  try {
    await gitExecFileAsync(['pull'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error))
  }
}

export async function gitFetch(worktreePath: string): Promise<void> {
  try {
    await gitExecFileAsync(['fetch', '--prune'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error))
  }
}
