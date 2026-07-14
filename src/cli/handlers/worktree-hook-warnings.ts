type HookWarningResult = {
  warning?: string
}

type PreservedBranchResult = {
  preservedBranch?: {
    branchName: string
  }
}

export function printHookWarning(result: HookWarningResult, json: boolean): void {
  if (!json && result.warning) {
    console.error(`warning: ${result.warning}`)
  }
}

export function printPreservedBranchWarning(result: PreservedBranchResult, json: boolean): void {
  if (!json && result.preservedBranch) {
    console.error(
      `warning: local branch "${result.preservedBranch.branchName}" was kept because Git could not safely delete it`
    )
  }
}
