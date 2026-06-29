import { execFile } from 'child_process'
import path from 'path'
import { promisify } from 'util'
import { buildLocalPreflightEnv } from './preflight-local-env'
import { runPreflightCommandInWsl } from './preflight-wsl-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)
export const PREFLIGHT_COMMAND_TIMEOUT_MS = 5000

export type PreflightCommandResult = { stdout: string; stderr: string }

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

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

export async function execLocalPreflightCommand(
  command: string,
  args: string[]
): Promise<PreflightCommandResult> {
  const env = buildLocalPreflightEnv()
  const commandPromise = execFileAsync(command, args, {
    encoding: 'utf-8',
    timeout: PREFLIGHT_COMMAND_TIMEOUT_MS,
    ...(env ? { env } : {})
  }) as Promise<PreflightCommandResult>

  return withPreflightTimeout(command, commandPromise)
}

export async function execCommandInWsl(
  target: WslPreflightTarget,
  command: string
): Promise<PreflightCommandResult> {
  const commandPromise = runPreflightCommandInWsl(target, command, PREFLIGHT_COMMAND_TIMEOUT_MS)
  return withPreflightTimeout('wsl.exe', commandPromise)
}

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

export async function isCommandOnPath(
  command: string,
  wslTarget?: WslPreflightTarget
): Promise<boolean> {
  const finder = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = wslTarget
      ? await execCommandInWsl(wslTarget, `command -v ${shellQuote(command)}`)
      : await execLocalPreflightCommand(finder, [command])
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => path.isAbsolute(line))
  } catch {
    return false
  }
}
