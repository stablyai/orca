import type { WorkingTreeCarryResult } from '../../shared/working-tree-change-carry'
import { carryLocalWorkingTreeChanges } from '../git/source-control/carry-working-tree-changes'
import {
  localGitOptionsForTarget,
  requireRuntimeGitProvider,
  type RuntimeGitCommandHost
} from './runtime-git-command-target'

export class RuntimeGitWorkingTreeCarryCommands {
  constructor(private readonly host: RuntimeGitCommandHost) {}

  async carryRuntimeWorkingTreeChanges(
    sourceSelector: string,
    targetSelector: string
  ): Promise<WorkingTreeCarryResult> {
    const [source, target] = await Promise.all([
      this.host.resolveRuntimeGitTarget(sourceSelector),
      this.host.resolveRuntimeGitTarget(targetSelector)
    ])
    // Why: the carry runs once on one host, which must see both worktrees' files and object store.
    if (source.executionHostId !== target.executionHostId) {
      throw new Error('Source and target worktrees must share a host')
    }
    if (source.worktree.repoId !== target.worktree.repoId) {
      throw new Error('Source and target worktrees must belong to the same repository')
    }
    const provider = requireRuntimeGitProvider(target)
    if (provider) {
      return provider.carryWorkingTreeChanges(source.worktree.path, target.worktree.path)
    }
    return carryLocalWorkingTreeChanges(source.worktree.path, target.worktree.path, {
      ...localGitOptionsForTarget(target),
      admissionTier: 'interactive'
    })
  }
}
