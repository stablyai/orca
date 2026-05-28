import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { discoverSkills } from '../skills/discovery'
import type { SkillDiscoveryResult } from '../../shared/skills'

export function registerSkillsHandlers(store: Store): void {
  ipcMain.handle('skills:discover', async (): Promise<SkillDiscoveryResult> => {
    return discoverSkills({ repos: store.getRepos() })
  })
}
