import { WINDOWS_HOOK_STDIN_DRAIN_COMMAND } from './hook-stdin-contract'
import { wrapWindowsHookCommand } from './installer-utils'

/**
 * Launcher for agents that hand the hook to `cmd.exe /c` as a command line rather than
 * spawning it as argv[0] (Junie). Missing script drains stdin (#11549); quoted path keeps
 * spaces without PowerShell's ~300ms startup. Paths with `%` fall back to PowerShell —
 * cmd expands %VAR% before if/call runs.
 */
export function wrapWindowsCmdShellHookCommand(scriptPath: string): string {
  if (scriptPath.includes('%')) {
    return wrapWindowsHookCommand(scriptPath)
  }
  return `if exist "${scriptPath}" (call "${scriptPath}") else (${WINDOWS_HOOK_STDIN_DRAIN_COMMAND})`
}
