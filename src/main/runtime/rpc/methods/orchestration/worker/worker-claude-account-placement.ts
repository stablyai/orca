import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

/** Refused before the dispatch row exists, so a remote placement never shows up as a failed start. */
export async function assertClaudeAccountWorktreeIsLocal(
  runtime: Pick<OrcaRuntimeService, 'showTerminalWorkspaceLaunchScope'>,
  worktreeId: string
): Promise<void> {
  const scope = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
  if (scope.connectionId) {
    throw new OrchestrationError(
      'invalid_argument',
      '--account runs Claude on this host only and cannot start a worker in an SSH workspace.'
    )
  }
}
