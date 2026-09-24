import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

export type OrchestrationCliCommand = 'orca' | 'orca-dev' | 'orca-ide'

/** The CLI invocation text a structured session's shell can run, one form per shell family. */
export type StructuredSessionCliInvocation = '"$ORCA_CLI_COMMAND"' | '& $env:ORCA_CLI_COMMAND'

/**
 * How text addressed to a structured session invokes this app's CLI, in the shell that session's
 * commands actually run in. The env carries the absolute launcher in `ORCA_CLI_COMMAND`; a bare
 * `orca` can resolve elsewhere once a profile-loading shell rebuilds PATH ahead of Orca's entry.
 *
 * - Codex on Windows runs PowerShell (pwsh, else Windows PowerShell) and loads its profile, so the
 *   env var is read as `$env:…` and invoked with `&`. Codex falls back to cmd only when no
 *   PowerShell exists at all, which Orca cannot see from here.
 * - Claude on Windows runs its commands in Git Bash; macOS and Linux shells are POSIX for both.
 */
export function structuredSessionCliInvocation(session: {
  platform: NodeJS.Platform
  provider: 'claude' | 'codex'
}): StructuredSessionCliInvocation {
  return session.platform === 'win32' && session.provider === 'codex'
    ? '& $env:ORCA_CLI_COMMAND'
    : '"$ORCA_CLI_COMMAND"'
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
