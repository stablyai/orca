import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { buildPosixCommandPathLookupScript } from '../../shared/posix-command-path-lookup'
import { buildLocalPreflightEnv } from './preflight-local-env'
import { runPreflightCommandInWsl } from './preflight-wsl-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)
export const PREFLIGHT_COMMAND_TIMEOUT_MS = 5000
const WSL_COMMAND_PATH_SENTINEL = '__ORCA_PREFLIGHT_COMMAND_PATH__'

export type PreflightCommandResult = { stdout: string; stderr: string }

/**
 * Quote one literal argument for a POSIX shell command.
 *
 * @param value Argument value to protect from shell expansion.
 * @returns Single-quoted shell token with embedded quotes escaped.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

/**
 * Bound a preflight subprocess promise even when its runtime timeout does not fire.
 *
 * @param command Command label included in timeout errors.
 * @param commandPromise Subprocess result to race against the preflight timeout.
 * @returns The subprocess result when it settles within the timeout.
 */
async function withPreflightTimeout<T>(command: string, commandPromise: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      commandPromise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          const error = Object.assign(new Error(`Timed out running ${command}`), {
            code: 'ETIMEDOUT'
          })
          reject(error)
        }, PREFLIGHT_COMMAND_TIMEOUT_MS)
        if (typeof timeout.unref === 'function') {
          timeout.unref()
        }
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

/**
 * Execute a local-host command with Orca's hydrated CLI environment.
 *
 * @param command Executable name or path.
 * @param args Literal argv entries passed without a shell.
 * @returns Captured stdout and stderr.
 */
export async function execLocalPreflightCommand(
  command: string,
  args: string[]
): Promise<PreflightCommandResult> {
  const env = await buildLocalPreflightEnv()
  const commandPromise = execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: PREFLIGHT_COMMAND_TIMEOUT_MS,
    env
  }) as Promise<PreflightCommandResult>

  return withPreflightTimeout(command, commandPromise)
}

/**
 * Execute a preflight command inside the selected WSL distribution.
 *
 * @param target WSL distribution and user context.
 * @param command POSIX command string to run in WSL.
 * @returns Captured stdout and stderr.
 */
export async function execCommandInWsl(
  target: WslPreflightTarget,
  command: string
): Promise<PreflightCommandResult> {
  const commandPromise = runPreflightCommandInWsl(target, command, PREFLIGHT_COMMAND_TIMEOUT_MS)
  return withPreflightTimeout('wsl.exe', commandPromise)
}

/**
 * Check whether a CLI can execute its version command in the selected runtime.
 *
 * @param command Executable name.
 * @param wslTarget Optional WSL runtime; omitted for the local host.
 * @returns True when the version command succeeds.
 */
export async function isCommandAvailable(
  command: string,
  wslTarget?: WslPreflightTarget
): Promise<boolean> {
  try {
    await (wslTarget
      ? execCommandInWsl(wslTarget, `${shellQuote(command)} --version`)
      : execLocalPreflightCommand(command, ['--version']))
    return true
  } catch {
    return false
  }
}

/**
 * Check whether a CLI resolves to an absolute executable path.
 *
 * @param command Executable name.
 * @param wslTarget Optional WSL runtime; omitted for the local host.
 * @returns True when the runtime path lookup returns an absolute path.
 */
export async function isCommandOnPath(
  command: string,
  wslTarget?: WslPreflightTarget
): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = wslTarget
      ? // Why: preflight must validate the executable on PATH, not a shell alias or function.
        await execCommandInWsl(
          wslTarget,
          [
            buildPosixCommandPathLookupScript({ kind: 'literal', value: command }),
            'if [ -n "$resolved" ]; then',
            `printf '${WSL_COMMAND_PATH_SENTINEL}%s\\n' "$resolved"`,
            'fi'
          ].join('\n')
        )
      : await execLocalPreflightCommand(finder, [command])
    if (wslTarget) {
      // Why: WSL startup chatter can contain unrelated absolute paths.
      return stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(WSL_COMMAND_PATH_SENTINEL))
        .map((line) => line.slice(WSL_COMMAND_PATH_SENTINEL.length))
        .some((line) => path.posix.isAbsolute(line))
    }

    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => path.isAbsolute(line))
  } catch {
    return false
  }
}
