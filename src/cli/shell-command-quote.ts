import type { AgentStartupShell } from '../shared/tui-agent-startup-shell'
import { quoteWindowsCmdArgument } from '../shared/child-process/windows-command-line'
import { quotePowerShellNativeArgument } from '../shared/powershell-native-argument'
import { resolveWindowsShellStartupFamily } from '../shared/windows-terminal-shell'

export type ShellQuoteOptions = {
  platform?: NodeJS.Platform
  shell?: AgentStartupShell
  env?: NodeJS.ProcessEnv
}

function resolveCliShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): AgentStartupShell {
  if (platform !== 'win32') {
    return 'posix'
  }
  const configured = env.ORCA_TERMINAL_WINDOWS_SHELL ?? env.ORCA_WINDOWS_SHELL
  return resolveWindowsShellStartupFamily(configured)
}

export function quoteCliCommandArgument(
  value: string,
  options?: AgentStartupShell | ShellQuoteOptions
): string {
  if (/^[a-zA-Z0-9._:/@-]+$/.test(value)) {
    return value
  }
  const opts = typeof options === 'string' ? { shell: options } : (options ?? {})
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const shell = opts.shell ?? resolveCliShell(platform, env)

  if (shell === 'powershell') {
    // Why: PowerShell expands `$var` in double quotes; quote with native-safe single quotes.
    return quotePowerShellNativeArgument(value)
  }
  if (shell === 'cmd') {
    return quoteWindowsCmdArgument(value)
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}
