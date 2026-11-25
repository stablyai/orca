import type { GitWorktreeExecOptions } from '../worktree-operation-options'
import { WorktreePreparationOperation } from './worktree-preparation-operation'

export async function runStandalonePreparation<T>(
  options: GitWorktreeExecOptions,
  work: (operation: WorktreePreparationOperation) => Promise<T>
): Promise<T> {
  const operation = new WorktreePreparationOperation(options)
  // A direct caller still owns its fetch barrier; only pool handoff supersedes it.
  operation.claim(false)
  let result!: T
  try {
    await operation.run(async () => {
      result = await work(operation)
    })
    return result
  } catch (error) {
    await operation.discard().catch(() => {})
    throw error
  } finally {
    operation.complete()
  }
}
