import { BrowserWindow } from 'electron'
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
import { SkillUpdateRunner } from '../skills/skill-update-run'
import {
  bundledSkillsStillToUpdate,
  scanBundledSkillFreshness,
  updateBundledSkills,
  type BundledSkillPlanner
} from '../skills/bundled-skill-freshness'
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
  // Why this machine's global homes only: WSL and SSH freshness stay out until their
  // installer rail has an equivalent proof.
  const requireRuntime = (): OrcaRuntimeService => {
    if (!runtime) {
      throw new Error('Skill installs are unavailable in this process.')
    }
    return runtime
  }
  const plan: BundledSkillPlanner = (names) => requireRuntime().planBundledOrcaSkills(names)
  const scanInventory = (): Promise<SkillFreshnessInventory> =>
    runtime
      ? scanBundledSkillFreshness(plan)
      : Promise.resolve({ schemaVersion: 2, skills: [], scannedAt: Date.now() })

  const runner = new SkillUpdateRunner({
    installSkills: (names, signal) =>
      updateBundledSkills(names, {
        plan,
        install: (updatable) => requireRuntime().installBundledOrcaSkills(updatable, signal)
      }),
    rescanOutdatedNames: async (names) => {
      // Why: the run just rewrote skill packages on this host. Clients that never
      // send `refresh` (older builds) would otherwise read a pre-run scan.
      clearSkillDiscoveryCaches()
      return bundledSkillsStillToUpdate(names, plan)
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
