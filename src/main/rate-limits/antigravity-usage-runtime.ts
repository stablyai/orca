import { runProcess } from '@orca/process-host'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'
import type { GlobalSettings } from '../../shared/global-settings-types'
import {
  resolveLocalAccountRuntimeTarget,
  type LocalAccountRuntimeTarget
} from '../../shared/local-account-runtime'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs
} from '../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { listWslDistrosAsync } from '../wsl'
import { isWslDistroRunning } from '../wsl-background-distro-gate'
import { resolveWslInteropSpawnCwd } from '../wsl-interop-spawn-directory'

export function getAntigravityUsageTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  return platform === 'win32'
    ? resolveLocalAccountRuntimeTarget(settings, platform)
    : { runtime: 'host', wslDistro: null }
}

export function antigravityUsageTargetKey(target: LocalAccountRuntimeTarget): string {
  return target.runtime === 'wsl'
    ? `wsl:${target.wslDistro?.trim().toLowerCase() || '__default__'}`
    : 'host'
}

export async function resolveRunningAntigravityWslDistro(
  target: LocalAccountRuntimeTarget
): Promise<string | null> {
  const distro = target.wslDistro?.trim() || (await listWslDistrosAsync())[0]
  return distro && (await isWslDistroRunning(distro)) ? distro : null
}

export async function runAntigravityWslProbe(
  spec: ProcessSpec,
  distro: string,
  run: typeof runProcess = runProcess
): Promise<ProcessResult> {
  const command = [spec.program, ...(spec.args ?? [])].map(quotePosixShell).join(' ')
  const capture = buildWslCapturedLoginShellCommand(
    `cd "$HOME" && AGY_CLI_DISABLE_AUTO_UPDATE=true ${command}`
  )
  const result = await run({
    ...spec,
    program: 'wsl.exe',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    args: buildWslExecArgs(distro, ['sh', '-c', capture.command]),
    cwd: resolveWslInteropSpawnCwd()
  })
  return { ...result, stdout: capture.readStdout(result.stdout) ?? '' }
}
