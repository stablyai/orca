import { app, BrowserWindow, ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  SkillDiscoveryTargetSchema,
  type SkillDiscoveryResult,
  type SkillDiscoveryTarget
} from '../../shared/skills'
import type {
  SkillFreshnessInventory,
  SkillUpdateRun,
  SkillUpdateStartResult
} from '../../shared/skill-freshness'
import { inventorySkillFreshness } from '../skills/skill-freshness-inventory'
import { SkillUpdateRunner } from '../skills/skill-update-run'
import { skillUpdateFailedNames } from '../skills/skill-update-outcome'
import { readGloballyUpdatableSkillLocks } from '../skills/skill-update-registration'
import {
  clearSkillDiscoveryCaches,
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'

export function registerSkillsHandlers(store: Store): void {
  const scanInventory = (): Promise<SkillFreshnessInventory> =>
    // Why: the update command targets this machine's global homes. WSL and SSH
    // inventories stay out until their installer rail has an equivalent proof.
    inventorySkillFreshness({
      currentAppVersion: app.getVersion(),
      repos: store.getRepos()
    })

  const runner = new SkillUpdateRunner({
    // Why: per-skill outcomes come from re-hashing what is actually on disk, not
    // from scraping stdout.
    rescanOutdatedNames: async (names) => {
      // Why: the run just rewrote skill packages on this host. Clients that never
      // send `refresh` (older builds) would otherwise read a pre-run scan.
      clearSkillDiscoveryCaches()
      // The lock read is fresh on purpose: the run just rewrote it, and the
      // verdict accepts unrecognized content only when disk matches that record.
      const [inventory, globalSkillLocks] = await Promise.all([
        scanInventory(),
        readGloballyUpdatableSkillLocks()
      ])
      return skillUpdateFailedNames(names, inventory.installations, globalSkillLocks)
    },
    onState: (run: SkillUpdateRun) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send('skills:updateRun', run)
        }
      }
    }
  })

  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
      return discoverSkillsOnTarget(
        resolveSkillDiscoveryTarget(parsedTarget),
        store.getRepos(),
        // Why: only a caller that knows disk changed may bypass the shared scans.
        { refresh: parsedTarget?.refresh === true }
      )
    }
  )

  ipcMain.handle('skills:freshnessInventory', async (): Promise<SkillFreshnessInventory> => {
    return scanInventory()
  })

  ipcMain.handle(
    'skills:startUpdateRun',
    async (_event, names: string[]): Promise<SkillUpdateStartResult> => {
      return runner.start(Array.isArray(names) ? names : [])
    }
  )

  ipcMain.handle('skills:cancelUpdateRun', async (): Promise<void> => {
    runner.cancel()
  })

  ipcMain.handle('skills:acknowledgeUpdateRun', async (): Promise<void> => {
    runner.acknowledge()
  })

  ipcMain.handle('skills:getUpdateRun', async (): Promise<SkillUpdateRun> => {
    return runner.getState()
  })
}
