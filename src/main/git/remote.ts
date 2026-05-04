import { gitExecFileAsync } from './runner'

function normalizeGitErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.message.includes('non-fast-forward') || error.message.includes('fetch first')) {
      // Why: this specific guidance tells users the safe recovery path instead
      // of surfacing raw git stderr that varies across git versions/locales.
      return 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
    }
    return error.message
  }
  return 'Git remote operation failed.'
}

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
  await gitExecFileAsync(['pull'], { cwd: worktreePath })
}

export async function gitFetch(worktreePath: string): Promise<void> {
  await gitExecFileAsync(['fetch', '--prune'], { cwd: worktreePath })
}
