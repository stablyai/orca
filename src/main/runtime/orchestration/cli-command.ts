import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

export type OrchestrationCliCommand = 'orca' | 'orca-dev' | 'orca-ide'

export function resolveTerminalOrchestrationCliCommand(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  runtimeCliCommand?: OrchestrationCliCommand
  hostPlatform?: NodeJS.Platform
}): OrchestrationCliCommand {
  if (args.connectionId) {
    return 'orca'
  }
  if (args.runtimeCliCommand) {
    return args.runtimeCliCommand
  }
  if (args.isWsl === true) {
    return 'orca-ide'
  }
  // Why: GNOME's screen reader also installs `/usr/bin/orca`; Linux workers need Orca's scoped launcher.
  if (args.hostPlatform === 'linux') {
    return 'orca-ide'
  }
  if (args.isWsl !== null && args.isWsl !== undefined) {
    return 'orca'
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'orca-ide'
  }

  const worktreePath = splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath
  if (worktreePath && isWslUncPath(worktreePath)) {
    return 'orca-ide'
  }
  return 'orca'
}
