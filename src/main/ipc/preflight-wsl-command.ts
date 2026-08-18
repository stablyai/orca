import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildWslExecArgs, buildWslLoginShellCommand } from '../../shared/wsl-login-shell-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)

export type PreflightWslCommandResult = { stdout: string; stderr: string }

export function runPreflightCommandInWsl(
  target: WslPreflightTarget,
  command: string,
  timeoutMs: number
): Promise<PreflightWslCommandResult> {
  return execFileAsync(
    'wsl.exe',
    buildWslExecArgs(target.distro, ['sh', '-c', buildWslLoginShellCommand(command)]),
    {
      encoding: 'utf-8',
      timeout: timeoutMs
    }
  ) as Promise<PreflightWslCommandResult>
}
