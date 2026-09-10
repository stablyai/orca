import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { resolveManagedCliExecutable } from '../../../shared/managed-cli-context'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

export type OrchestrationCliCommand = 'orca' | 'orca-dev' | 'orca-ide'

export type ManagedOrchestrationCli = OrchestrationCliCommand | 'orca-dev'

export function resolveManagedOrchestrationCli(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  isPackaged?: boolean
}): ManagedOrchestrationCli {
  if (args.isPackaged === false) {
    return 'orca-dev'
  }
  return resolveTerminalOrchestrationCliCommand(args)
}

export function resolveManagedOrchestrationExecutable(args: {
  connectionId: string | null
  isWsl: boolean | null | undefined
  worktreeId: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  isPackaged: boolean
  launcherPath?: string | null
}): string {
  return resolveManagedCliExecutable({
    platform: args.isWsl ? 'linux' : process.platform,
    isPackaged: args.isPackaged,
    launcherPath: args.launcherPath,
    devCommand: resolveManagedOrchestrationCli(args)
  })
}

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
