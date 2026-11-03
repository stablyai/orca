import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { isStructuredWorkerHandle } from '../../../shared/structured-worker-handle'
import { parseOrcaSessionAddress } from '../../../shared/orca-session-address'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { getAppEnvironment, hasAppEnvironment } from '../../../shared/app-environment'

export type OrchestrationCliCommand = 'orca' | 'orca-dev' | 'orca-ide'

/** Dev builds run the CLI as `orca-dev`; a packaged app, or a process with no app, must not advertise it. */
export function runtimeOrchestrationCliCommand(): OrchestrationCliCommand | undefined {
  return hasAppEnvironment() && !getAppEnvironment().isPackaged() ? 'orca-dev' : undefined
}

/** What a local, non-WSL terminal is told to run; a structured session is always one. */
export function localOrchestrationCliCommand(): OrchestrationCliCommand {
  return runtimeOrchestrationCliCommand() ?? 'orca'
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

export function resolveRuntimeTerminalOrchestrationCliCommand(
  handle: string,
  source: {
    resolvePtyId: (handle: string) => string | null | undefined
    getPty: (ptyId: string) => RuntimePtyWorktreeRecord | undefined
    getProjectRuntime: (
      pty: RuntimePtyWorktreeRecord
    ) => ProjectExecutionRuntimeResolution | undefined
  }
): OrchestrationCliCommand {
  // A structured session runs in this process: it is told what the structured mail lane types.
  if (isStructuredWorkerHandle(handle) || parseOrcaSessionAddress(handle)) {
    return localOrchestrationCliCommand()
  }
  let pty: RuntimePtyWorktreeRecord | null = null
  try {
    const ptyId = source.resolvePtyId(handle)
    pty = ptyId ? (source.getPty(ptyId) ?? null) : null
  } catch {
    return 'orca'
  }
  if (!pty) {
    return 'orca'
  }
  return resolveTerminalOrchestrationCliCommand({
    connectionId: pty.connectionId,
    isWsl: pty.isWsl,
    worktreeId: pty.worktreeId,
    runtimeCliCommand: runtimeOrchestrationCliCommand(),
    projectRuntime: source.getProjectRuntime(pty)
  })
}
