import type { AddWorktreeOptions } from '../../../git/worktrees/worktree-operation-options'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'

export type ConsumePreparedWorktreeArgs = {
  repoPath: string
  workspaceRoot: string
  worktreePath: string
  branch: string
  baseBranch: string
  refreshLocalBaseRef?: boolean
  options?: AddWorktreeOptions
  timing?: Pick<
    WorktreeCreateTimingRecorder,
    'time' | 'recordPreparedCheckout' | 'recordAdoptedPreparation'
  >
}
