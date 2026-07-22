import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree-id'
import type { PtyOrchestrationCliCommand } from '../../providers/pty-orchestration-cli-command'

export type OrchestrationCliCommand = 'orca' | 'orca-ide' | PtyOrchestrationCliCommand

export function resolveTerminalOrchestrationCliCommand(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  sshCliCommand?: PtyOrchestrationCliCommand | null
  projectRuntime?: ProjectExecutionRuntimeResolution
}): OrchestrationCliCommand {
  if (args.connectionId) {
    if (!args.sshCliCommand) {
      throw new Error(
        'SSH orchestration is unavailable because the remote CLI launcher was not installed. Reconnect the SSH target and retry.'
      )
    }
    return args.sshCliCommand
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
