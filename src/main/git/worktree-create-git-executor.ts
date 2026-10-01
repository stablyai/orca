import { createGitOperationExecutor } from './command-runner/git-operation-executor'
import { runWithLocalWorktreeCreateHold } from './local-worktree-create-activity'
import { abandonUnfinishedSpares } from '../worktree-create-preparation-pool'
import { noteLocalCreateStarted } from '../worktree-create-spare-gate'

export const worktreeCreateGit = createGitOperationExecutor('interactive')

/**
 * A local create: interactive git priority, background work held off until it settles, and every
 * unfinished spare on the machine stopped at once instead of awaited.
 */
export function runLocalWorktreeCreate<T>(operation: () => Promise<T>): Promise<T> {
  return runWithLocalWorktreeCreateHold(async () => {
    noteLocalCreateStarted()
    abandonUnfinishedSpares()
    return worktreeCreateGit.run(operation)
  })
}
