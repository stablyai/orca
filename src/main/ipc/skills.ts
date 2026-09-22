import { app, BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
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
import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'
import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

export function registerSkillsHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const discover = async (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
    const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
    const resolvedTarget = resolveSkillDiscoveryTarget(parsedTarget)
    return discoverSkillsOnTarget(resolvedTarget, store.getRepos(), {
      providerRootOverrides: await runtime?.resolveSkillDiscoveryProviderRoots(resolvedTarget),
      refresh: parsedTarget?.refresh === true
    })
  }
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

  handleMainWindowSkillIpc(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => discover(target)
  )

  if (runtime) {
    registerSkillCloudIpcHandlers(runtime, discover)
  }

  handleMainWindowSkillIpc(
    'skills:freshnessInventory',
    async (): Promise<SkillFreshnessInventory> => {
      return scanInventory()
    }
  )

  handleMainWindowSkillIpc(
    'skills:startUpdateRun',
    async (_event, names: string[]): Promise<SkillUpdateStartResult> => {
      return runner.start(Array.isArray(names) ? names : [])
    }
  )

  handleMainWindowSkillIpc('skills:cancelUpdateRun', async (): Promise<void> => {
    runner.cancel()
  })

  handleMainWindowSkillIpc('skills:acknowledgeUpdateRun', async (): Promise<void> => {
    runner.acknowledge()
  })

  handleMainWindowSkillIpc('skills:getUpdateRun', async (): Promise<SkillUpdateRun> => {
    return runner.getState()
  })
}
