import { parseWslPath, toLinuxPath } from './wsl'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'

export type HookRuntimeTarget = {
  wslDistro?: string | null
}

export function getHookRuntimeTarget(
  projectRuntime?: ProjectExecutionRuntimeResolution | HookRuntimeTarget
): HookRuntimeTarget | undefined {
  if (!projectRuntime) {
    return undefined
  }

  if ('status' in projectRuntime) {
    if (projectRuntime.status === 'repair-required') {
      return projectRuntime.repair.preferredRuntime.kind === 'wsl'
        ? { wslDistro: projectRuntime.repair.preferredRuntime.distro }
        : undefined
    }
    return projectRuntime.runtime.kind === 'wsl'
      ? { wslDistro: projectRuntime.runtime.distro }
      : undefined
  }

  return projectRuntime.wslDistro ? { wslDistro: projectRuntime.wslDistro } : undefined
}

export function getHookWslContext(
  cwd: string,
  runtimeTarget?: HookRuntimeTarget
): { distro: string | null; linuxPath: string } | null {
  const pathInfo = parseWslPath(cwd)
  if (pathInfo) {
    return pathInfo
  }

  const wslDistro = runtimeTarget?.wslDistro?.trim()
  if (!wslDistro) {
    return null
  }

  // Why: project runtime can route a Windows checkout through WSL, so hooks need the Linux view of the path.
  return {
    distro: wslDistro,
    linuxPath: toLinuxPath(cwd)
  }
}
