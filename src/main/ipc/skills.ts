import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  SkillDiscoveryTargetSchema,
  type SkillDiscoveryResult,
  type SkillDiscoveryTarget
} from '../../shared/skills'
import {
  BundledSkillExecuteRequestSchema,
  BundledSkillPlanRequestSchema,
  type BundledSkillInstallResult,
  type BundledSkillPlan
} from '../../shared/bundled-skill-plan'
import {
  discoverSkillsOnTarget,
  resolveSkillDiscoveryTarget
} from '../skills/skill-discovery-target'
import { unavailableWhileWslDistroStopped } from '../skills/skill-discovery-stopped-wsl-roots'
import { runAsWslUserAct, wslDistroForPath } from '../wsl/wsl-unc-access-gate'
import { registerSkillCloudIpcHandlers } from './skill-cloud-ipc-handlers'
import { handleMainWindowSkillIpc } from './skill-ipc-main-window'

export function registerSkillsHandlers(store: Store, runtime?: OrcaRuntimeService): void {
  const discoverResolved = async (
    resolvedTarget: Awaited<ReturnType<typeof resolveSkillDiscoveryTarget>>,
    refresh: boolean,
    userAct = false
  ): Promise<SkillDiscoveryResult> =>
    discoverSkillsOnTarget(resolvedTarget, store.getRepos(), {
      providerRootOverrides: await runtime?.resolveSkillDiscoveryProviderRoots(resolvedTarget),
      refresh,
      ...(userAct ? { gateStoppedWslDistros: false } : {})
    })
  // Passive UI mounts discovery, so it must not start a stopped WSL distro.
  const discover = async (target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => {
    const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
    return unavailableWhileWslDistroStopped(
      async () =>
        discoverResolved(
          await resolveSkillDiscoveryTarget(parsedTarget, { refuseStoppedWslDistro: true }),
          parsedTarget?.refresh === true
        ),
      parsedTarget?.sourceKinds
    )
  }
  // Share is a click on named skills: it may start their distro, as any user act may.
  const discoverForUserAct = async (
    target?: SkillDiscoveryTarget
  ): Promise<SkillDiscoveryResult> => {
    const parsedTarget = target ? SkillDiscoveryTargetSchema.parse(target) : undefined
    const resolvedTarget = await resolveSkillDiscoveryTarget(parsedTarget)
    const distro =
      resolvedTarget.kind === 'wsl'
        ? resolvedTarget.distro
        : resolvedTarget.cwd
          ? wslDistroForPath(resolvedTarget.cwd)
          : null
    return runAsWslUserAct(distro, () =>
      discoverResolved(resolvedTarget, parsedTarget?.refresh === true, true)
    )
  }

  handleMainWindowSkillIpc(
    'skills:discover',
    async (_event, target?: SkillDiscoveryTarget): Promise<SkillDiscoveryResult> => discover(target)
  )

  if (!runtime) {
    return
  }
  registerSkillCloudIpcHandlers(runtime, discoverForUserAct)

  // Local host only; paired hosts plan Orca's skills over RPC.
  handleMainWindowSkillIpc(
    'skills:bundledPlan',
    async (_event, value: unknown): Promise<BundledSkillPlan> =>
      runtime.planLocalBundledSkills(BundledSkillPlanRequestSchema.parse(value ?? {}))
  )
  handleMainWindowSkillIpc(
    'skills:bundledExecute',
    async (_event, value: unknown): Promise<BundledSkillInstallResult> =>
      runtime.executeLocalBundledSkills(BundledSkillExecuteRequestSchema.parse(value))
  )
}
