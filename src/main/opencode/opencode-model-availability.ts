import { resolveStartupShell, tokenizeStartupCommand } from '../../shared/tui-agent-startup-shell'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'

export async function resolveOpenCodeDirectModelExecutable(options: {
  command: string | undefined
  model: string
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

export async function probeOpenCodeModelAvailability(
  options: Parameters<typeof resolveOpenCodeDirectModelExecutable>[0]
): Promise<boolean> {
  const executable = await resolveOpenCodeDirectModelExecutable(options)
  if (!executable) {
    return false
  }
  try {
    const result = await runProcess({
      program: executable,
      args: ['models'],
      cwd: options.cwd,
      env: options.env,
      timeoutMs: 10_000,
      maxOutputBytes: 1_048_576
    })
    return (
      result.code === 0 &&
      !result.timedOut &&
      !result.outputTruncated &&
      result.stdout.endsWith('\n') &&
      result.stdout.split(/\r?\n/).some((line) => line === options.model)
    )
  } catch {
    return false
  }
}
