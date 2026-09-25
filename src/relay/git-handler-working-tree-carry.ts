import {
  carryWorkingTreeChanges,
  type WorkingTreeCarryResult
} from '../shared/working-tree-change-carry'
import {
  copyNodeWorkingTreeEntry,
  nodeWorkingTreeEntryExists,
  removeNodeWorkingTreeEntry,
  sumNodeEntrySizes
} from '../shared/working-tree-change-carry-node-fs'
import { expandTilde } from './context'
import { GitHandlerOperationContext } from './git-handler-operation-context'

export class GitHandlerWorkingTreeCarryOperations extends GitHandlerOperationContext {
  async carryWorkingTreeChanges(params: Record<string, unknown>): Promise<WorkingTreeCarryResult> {
    const { sourceWorktreePath, targetWorktreePath } = params
    if (
      typeof sourceWorktreePath !== 'string' ||
      typeof targetWorktreePath !== 'string' ||
      !sourceWorktreePath ||
      !targetWorktreePath
    ) {
      throw new Error('carryWorkingTreeChanges requires source and target worktree paths')
    }
    this.clearGitMutationReadCaches()
    try {
      return await carryWorkingTreeChanges(
        {
          git: async (args, cwd) => (await this.git(args, cwd)).stdout,
          sumEntrySizes: sumNodeEntrySizes,
          copyEntry: copyNodeWorkingTreeEntry,
          removeEntry: removeNodeWorkingTreeEntry,
          entryExists: nodeWorkingTreeEntryExists
        },
        // Why: this.git expands '~' for its cwd, but the fs io reads these roots directly.
        expandTilde(sourceWorktreePath),
        expandTilde(targetWorktreePath)
      )
    } finally {
      this.clearGitMutationReadCaches()
    }
  }
}
