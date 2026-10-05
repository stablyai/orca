import { resolveWslSessionContext } from '../../daemon/wsl-session-context'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveLocalWindowsTerminalRuntimeOptions } from '../../../shared/local-windows-terminal-runtime'
import {
  resolveTerminalOrchestrationCliCommand,
  runtimeOrchestrationCliCommand,
  type OrchestrationCliCommand
} from './cli-command'

/**
 * The command a terminal not yet spawned will be told to run: what `getTerminalOrchestrationCliCommand`
 * answers once it exists, from the WSL decision its spawn makes (spawn-preflight).
 */
export function predictSpawnOrchestrationCliCommand(args: {
  connectionId: string | null
  /** The directory the terminal starts in; a WSL UNC path puts it in that distro. */
  cwd: string
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  settings: Partial<Pick<GlobalSettings, 'terminalWindowsShell' | 'terminalWindowsWslDistro'>>
}): OrchestrationCliCommand {
  let isWsl = false
  if (!args.connectionId && process.platform === 'win32') {
    const options = resolveLocalWindowsTerminalRuntimeOptions({
      requestedShellOverride: undefined,
      settings: args.settings,
      projectRuntime: args.projectRuntime,
      fallbackHostShell: process.env.COMSPEC || 'powershell.exe'
    })
    isWsl = Boolean(
      resolveWslSessionContext({
        cwd: args.cwd,
        shellOverride: options.shellOverride,
        terminalWindowsWslDistro: options.terminalWindowsWslDistro
      })
    )
  }
  return resolveTerminalOrchestrationCliCommand({
    connectionId: args.connectionId,
    isWsl,
    // Unread: `isWsl` is always decided here, so the worktree-path fallback never runs.
    worktreeId: '',
    projectRuntime: args.projectRuntime,
    runtimeCliCommand: runtimeOrchestrationCliCommand()
  })
}
