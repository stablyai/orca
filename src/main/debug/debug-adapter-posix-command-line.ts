import type { DebugAdapterConfig } from '../../shared/debug-session-types'

/**
 * Builds a POSIX shell command line that `exec`s the adapter process
 * directly (replacing the shell), so the process shares its lifetime 1:1
 * with whatever transport runs this line — an SSH channel or a `wsl.exe`
 * child. Shared by `ssh-relay-exec-stream.ts` and the WSL spawn path in
 * `debug-adapter-process-host.ts`, which only differ in their quoting
 * function (both are POSIX single-quote escaping, just imported from
 * different modules).
 */
export function buildPosixExecCommandLine(
  config: Pick<DebugAdapterConfig, 'command' | 'args' | 'cwd' | 'env'>,
  quote: (value: string) => string
): string {
  const envPrefix = config.env
    ? `${Object.entries(config.env)
        .map(([key, value]) => `${key}=${quote(value)}`)
        .join(' ')} `
    : ''
  const argv = [config.command, ...config.args].map(quote).join(' ')
  const execLine = `${envPrefix}exec ${argv}`
  return config.cwd ? `cd ${quote(config.cwd)} && ${execLine}` : execLine
}
