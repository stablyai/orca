import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { discoverSkills } from '../skills/discovery'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import { getDefaultWslDistro, getWslHome } from '../wsl'

type SkillDiscoveryRuntimeTarget =
  | { runtime: 'host' }
  | { runtime: 'wsl'; wslDistro: string | null | undefined }

function getSkillDiscoveryRuntimeTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryRuntimeTarget {
  const projectRuntime = target?.projectRuntime
  if (!projectRuntime) {
    return target?.runtime === 'wsl'
      ? { runtime: 'wsl', wslDistro: target.wslDistro }
      : { runtime: 'host' }
  }

  if (projectRuntime.status === 'repair-required') {
    throw new Error(
      `Project runtime requires repair before skill discovery: ${projectRuntime.repair.reason}`
    )
  }

  if (projectRuntime.runtime.kind === 'wsl') {
    return { runtime: 'wsl', wslDistro: projectRuntime.runtime.distro }
  }

  return { runtime: 'host' }
}

export function registerSkillsHandlers(store: Store): void {
  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      const runtimeTarget = getSkillDiscoveryRuntimeTarget(target)
      if (runtimeTarget.runtime === 'wsl') {
        if (process.platform !== 'win32') {
          throw new Error('WSL skill discovery is only available on Windows.')
        }
        const distro = runtimeTarget.wslDistro?.trim() || getDefaultWslDistro()
        if (!distro) {
          throw new Error('No WSL distribution is available for skill discovery.')
        }
        const homeDir = getWslHome(distro)
        if (!homeDir) {
          throw new Error(`Could not resolve the WSL home directory for ${distro}.`)
        }
        return discoverSkills({ repos: [], homeDir, cwd: homeDir })
      }

      return discoverSkills({ repos: store.getRepos() })
    }
  )
}
