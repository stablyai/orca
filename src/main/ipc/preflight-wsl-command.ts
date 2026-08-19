import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

const execFileAsync = promisify(execFile)

export type PreflightWslCommandResult = { stdout: string; stderr: string }

export async function runPreflightCommandInWsl(
  target: WslPreflightTarget,
  command: string,
  timeoutMs: number
): Promise<PreflightWslCommandResult> {
  // Why: callers match this stdout against version and auth-status patterns; a
  // distro rc banner ahead of the real output makes a working CLI look missing.
  const captured = buildWslCapturedLoginShellCommand(command)
  const result = (await execFileAsync(
    'wsl.exe',
    buildWslExecArgs(target.distro, ['sh', '-c', captured.command]),
    {
      encoding: 'utf-8',
      timeout: timeoutMs
    }
  )) as PreflightWslCommandResult
  const payload = captured.readStdout(result.stdout)
  return payload === null ? result : { ...result, stdout: payload }
}
