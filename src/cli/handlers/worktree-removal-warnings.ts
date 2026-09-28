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
  // Why (#19334): a waived archive-hook failure is the one case where Orca deleted a checkout
  // whose archive step did not succeed. It has to stay visible in human output.
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
