import {
  formatArchiveHookOverride,
  type ArchiveHookOverride
} from '../../shared/worktree/archive-hook-removal-gate'

type HookWarningResult = {
  warning?: string
  archiveHookOverride?: ArchiveHookOverride
}

type PreservedBranchResult = {
  preservedBranch?: {
    branchName: string
  }
}

export function printHookWarning(result: HookWarningResult, json: boolean): void {
  if (json) {
    return
  }
  if (result.warning) {
    console.error(`warning: ${result.warning}`)
  }
  // A waived archive failure must remain visible after the checkout is deleted.
  if (result.archiveHookOverride) {
    console.error(`warning: ${formatArchiveHookOverride(result.archiveHookOverride)}`)
  }
}

export function printPreservedBranchWarning(result: PreservedBranchResult, json: boolean): void {
  if (!json && result.preservedBranch) {
    console.error(
      `warning: local branch "${result.preservedBranch.branchName}" was kept because Git could not safely delete it`
    )
  }
}
