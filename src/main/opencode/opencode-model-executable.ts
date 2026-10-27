import { resolveStartupShell, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'

export async function resolveOpenCodeDirectModelExecutable(options: {
  command: string | undefined
  env: NodeJS.ProcessEnv
  cwd?: string
  wsl?: { distro?: string }
}): Promise<string | null> {
  // WSL needs the same guest account/profile environment as its actual launch.
  if (options.wsl || !options.cwd) {
    return null
  }
  const parsed = tokenizeStartupCommand(
    options.command ?? '',
    resolveStartupShell(process.platform)
  )
  if (
    !parsed.ok ||
    parsed.tokens.length !== 1 ||
    parsed.spans.some((span) => span.divergesFromShell)
  ) {
    return null
  }
  return resolveCommandOnLocalPath(parsed.tokens[0], {
    env: options.env,
    cwd: options.cwd
  })
}
