import { app, ipcMain } from 'electron'
import type { Store } from '../persistence'
import {
  SkillDiscoveryTargetSchema,
  type SkillDiscoveryResult,
  type SkillDiscoveryTarget
} from '../../shared/skills'
import type { SkillFreshnessInventory } from '../../shared/skill-freshness'
import { inventorySkillFreshness } from '../skills/skill-freshness-inventory'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'
import { callRuntimeEnvironment } from './runtime-environment-transport-routing'

export function registerSkillsHandlers(store: Store): void {
  ipcMain.handle(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
      const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
      // Why: when connected to a remote Orca runtime the skill files live on
      // the server, not on the local host. Proxy to the server's RPC method so
      // discovery scans the correct filesystem. Prefer an explicit environmentId
      // from the caller, then fall back to the persisted active environment.
      const environmentId =
        target?.environmentId?.trim() || store.getSettings().activeRuntimeEnvironmentId?.trim()
      if (environmentId) {
        const response = await callRuntimeEnvironment(
          app.getPath('userData'),
          environmentId,
          'skills.discover',
          parsedTarget,
          15_000
        )
        if (response.ok) {
          return response.result as SkillDiscoveryResult
        }
        return { skills: [], sources: [], scannedAt: Date.now() }
      }
      return discoverSkillsOnTarget(resolveSkillDiscoveryTarget(parsedTarget), store.getRepos())
    }
  )

  ipcMain.handle('skills:freshnessInventory', async (): Promise<SkillFreshnessInventory> => {
    // Why: the update command targets this machine's global homes. WSL and SSH
    // inventories stay out until their installer rail has an equivalent proof.
    return inventorySkillFreshness({
      currentAppVersion: app.getVersion(),
      repos: store.getRepos()
    })
  })
}
