import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/**
 * Refused before the dispatch row exists, so a remote placement never shows up as a failed start.
 * No worktree id means no `--account` or a worktree this start creates, which is checked there.
 */
export async function assertClaudeAccountWorktreeIsLocal(
  runtime: {
    showTerminalWorkspaceLaunchScope(selector: string): Promise<{ connectionId?: string | null }>
  },
  worktreeId: string | undefined
): Promise<void> {
  if (!worktreeId) {
    return
  }
  const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
  if (scope.connectionId) {
    throw new OrchestrationError(
      'invalid_argument',
      '--account runs Claude on this host only and cannot start a worker in an SSH workspace.'
    )
  }
}
