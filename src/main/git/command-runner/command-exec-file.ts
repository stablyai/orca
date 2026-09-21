import { isWindowsBatchScript, resolveWindowsCommand } from '../../win32-utils'
import { resolveCommand, type ResolvedCommand } from './wsl-command-resolution'
import { execFileCapture } from './exec-file-capture'
import { spawnCommandCapture, type CommandExecOptions } from './spawn-command-capture'

function isMissingCommandError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function hasPathSeparator(command: string): boolean {
  return command.includes('/') || command.includes('\\')
}

function shouldRetryWindowsCommandShim(error: unknown, resolved: ResolvedCommand): boolean {
  return (
    process.platform === 'win32' &&
    resolved.wsl === null &&
    isMissingCommandError(error) &&
    !hasPathSeparator(resolved.binary) &&
    !/\.[A-Za-z0-9]+$/.test(resolved.binary)
  )
}

/**
 * Async command execution with the same WSL cwd translation as repo-scoped git.
 * Keep this for fixed binary+argv call sites; never pass shell fragments.
 */
export async function commandExecFileAsync(
  command: string,
  args: string[],
  options: CommandExecOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  const { wslDistro, ...execOptions } = options
  const resolved = resolveCommand(command, args, options.cwd, wslDistro)
  const binary =
    resolved.wsl === null ? resolveWindowsCommand(resolved.binary, options.env) : resolved.binary
  if (isWindowsBatchScript(binary)) {
    return spawnCommandCapture(binary, resolved.args, {
      ...execOptions,
      cwd: resolved.cwd
    })
  }
  try {
    const { stdout, stderr } = await execFileCapture(binary, resolved.args, {
      cwd: resolved.cwd,
      encoding: execOptions.encoding ?? 'utf-8',
      maxBuffer: execOptions.maxBuffer,
      timeout: execOptions.timeout,
      env: execOptions.env,
      signal: execOptions.signal
    })
    return { stdout: stdout as string, stderr: stderr as string }
  } catch (error) {
    if (shouldRetryWindowsCommandShim(error, resolved)) {
      return spawnCommandCapture(
        resolveWindowsCommand(`${resolved.binary}.cmd`, options.env),
        resolved.args,
        {
          ...execOptions,
          cwd: resolved.cwd
        }
      )
    }
    throw error
  }
}
