import {
  carryWorkingTreeChanges,
  type WorkingTreeCarryResult
} from '../../../shared/working-tree-change-carry'
import {
  copyNodeWorkingTreeEntry,
  findNodeSymlinkedAncestor,
  nodeWorkingTreeEntryExists,
  removeNodeWorkingTreeEntry,
  sumNodeEntrySizes
} from '../../../shared/working-tree-change-carry-node-fs'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'

export async function carryLocalWorkingTreeChanges(
  sourcePath: string,
  targetPath: string,
  options: GitRuntimeOptions = {}
): Promise<WorkingTreeCarryResult> {
  invalidateGitReadCaches()
  try {
    return await carryWorkingTreeChanges(
      {
        git: async (args, cwd) =>
          (await gitExecFileAsync(args, gitOptionsForWorktree(cwd, options))).stdout,
        sumEntrySizes: sumNodeEntrySizes,
        copyEntry: copyNodeWorkingTreeEntry,
        removeEntry: removeNodeWorkingTreeEntry,
        entryExists: nodeWorkingTreeEntryExists,
        findSymlinkedAncestor: findNodeSymlinkedAncestor
      },
      sourcePath,
      targetPath
    )
  } finally {
    invalidateGitReadCaches()
  }
}
