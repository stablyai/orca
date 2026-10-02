import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

export type PreflightRuntimeContext = {
  wslDistro?: string | null
  wslDefault?: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
  // Why: names the SSH execution host so runPreflightCheck can additionally
  // probe forge CLIs there — rides the context the same way wslDistro/
  // wslDefault ride the WSL target, but needs no derivation function since
  // it is a single flat shape rather than several fallback sources.
  sshHost?: { connectionId: string; hostLabel: string }
}

export function getPreflightWslTarget(
  context?: PreflightRuntimeContext,
  platform: string = process.platform
): WslPreflightTarget | null {
  if (platform !== 'win32') {
    return null
  }
  if (context?.projectRuntime) {
    if (context.projectRuntime.status === 'repair-required') {
      throw new Error(
        `Project runtime requires repair before preflight: ${context.projectRuntime.repair.reason}`
      )
    }
    return context.projectRuntime.runtime.kind === 'wsl'
      ? { distro: context.projectRuntime.runtime.distro }
      : null
  }
  const distro = context?.wslDistro?.trim()
  if (distro) {
    return { distro }
  }
  return context?.wslDefault ? {} : null
}
