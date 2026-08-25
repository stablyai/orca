import type { AgentStartupShell } from '../../shared/tui-agent-startup-shell'

/** The dialect that parses a spawn's launch command.
 *
 * Why not just `process.platform`: a WSL pane and an SSH pane both run a POSIX
 * shell while Orca itself is on Windows, and a Windows pane can be pointed at
 * cmd or Git Bash instead of PowerShell. Callers that splice into the command
 * text must model the shell that will actually parse it.
 */
export function resolveSpawnStartupShell(opts: {
  connectionId: string | null | undefined
  windowsWslDistro: string | null | undefined
  shellOverride: string | undefined
  platform: NodeJS.Platform
}): AgentStartupShell {
  if (opts.connectionId || opts.windowsWslDistro || opts.platform !== 'win32') {
    return 'posix'
  }
  const base =
    opts.shellOverride?.trim().replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  if (/^(?:ba|z|k|da|)sh(?:\.exe)?$/.test(base)) {
    return 'posix'
  }
  return base.startsWith('cmd') ? 'cmd' : 'powershell'
}
