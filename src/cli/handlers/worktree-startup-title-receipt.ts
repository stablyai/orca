import type { RuntimeWorktreeCreateResult } from '../../shared/runtime-types'

export function annotateStartupTitleReceipt(
  result: RuntimeWorktreeCreateResult,
  requestedTitle: string | undefined
): void {
  if (!requestedTitle || result.startupTerminal?.title === requestedTitle) {
    return
  }
  const warning =
    'The worktree was created, but this host did not confirm the requested startup terminal title. Inspect the returned terminal with terminal show; do not repeat worktree create.'
  result.warning = result.warning ? `${result.warning} ${warning}` : warning
}
