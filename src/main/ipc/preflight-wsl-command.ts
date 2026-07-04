import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows
} from '../../shared/wsl-login-shell-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)

export type PreflightWslCommandResult = { stdout: string; stderr: string }

export function runPreflightCommandInWsl(
  target: WslPreflightTarget,
  command: string,
  timeoutMs: number
): Promise<PreflightWslCommandResult> {
  const distroArgs = target.distro ? ['-d', target.distro] : []
  return execFileAsync(
    'wsl.exe',
    [
      ...distroArgs,
      '--',
      'sh',
      '-c',
      escapeWslShCommandForWindows(buildWslLoginShellCommand(command))
    ],
    {
      encoding: 'utf-8',
      timeout: timeoutMs
    }
  ) as Promise<PreflightWslCommandResult>
}
