import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { discoverSkills } from '../skills/discovery'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../shared/skills'
import { getDefaultWslDistro, getWslHome } from '../wsl'

export function registerSkillsHandlers(store: Store): void {
  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      if (target?.runtime === 'wsl') {
        if (process.platform !== 'win32') {
          throw new Error('WSL skill discovery is only available on Windows.')
        }
        const distro = target.wslDistro?.trim() || getDefaultWslDistro()
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
