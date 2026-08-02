import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { WslPreflightTarget } from './preflight-wsl-agent-detection'

export type PreflightRuntimeContext = {
  wslDistro?: string | null
  wslDefault?: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
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
