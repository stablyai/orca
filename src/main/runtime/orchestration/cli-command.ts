import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

export type OrchestrationCliCommand = 'orca' | 'orca-dev' | 'orca-ide'

/**
 * How text addressed to a structured session names this app's CLI. Its env carries the absolute
 * launcher in `ORCA_CLI_COMMAND`; a bare `orca` can resolve elsewhere once a login shell (Codex runs
 * `zsh -lc`) rebuilds PATH ahead of the directory Orca prepended.
 */
export const STRUCTURED_SESSION_CLI_COMMAND = '"$ORCA_CLI_COMMAND"'

export function resolveTerminalOrchestrationCliCommand(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  runtimeCliCommand?: OrchestrationCliCommand
}): OrchestrationCliCommand {
  if (args.connectionId) {
    return 'orca'
  }
  if (args.runtimeCliCommand) {
    return args.runtimeCliCommand
  }
  if (args.isWsl !== null && args.isWsl !== undefined) {
    return args.isWsl ? 'orca-ide' : 'orca'
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'orca-ide'
  }

  const worktreePath = splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath
  return worktreePath && isWslUncPath(worktreePath) ? 'orca-ide' : 'orca'
}
