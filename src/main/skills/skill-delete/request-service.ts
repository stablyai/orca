import { join } from 'node:path'
import type { Repo } from '../../../shared/repo-types'
import type {
  SkillDeletePlan,
  SkillDeleteRequest,
  SkillDeleteResult
} from '../../../shared/skill-delete-contract'
import { deleteSkills, previewSkillDeletion, type SkillDeleteServiceInput } from './service'
import type { ResolvedSkillDiscoveryTarget } from '../skill-discovery-target'
import { nativeSkillInstallFilesystem } from '../skill-install-filesystem'
import type { SkillProviderRootOverrides } from '../skill-provider-destinations'
import { WslSkillInstallFilesystem } from '../skill-wsl-install-filesystem'

/** Assembly shared by the local IPC channel and the runtime RPC method, so both
 *  transports resolve the same host, roots, and filesystem. */
export type SkillDeleteRequestDependencies = {
  repos: () => readonly Repo[]
  resolveProviderRootOverrides?: (
    target: ResolvedSkillDiscoveryTarget
  ) => Promise<SkillProviderRootOverrides | undefined>
  /** `app.getPath('userData')`; the skill-install state root hangs off it. */
  userDataPath: string
}

async function serviceInput(
  request: SkillDeleteRequest,
  target: ResolvedSkillDiscoveryTarget,
  dependencies: SkillDeleteRequestDependencies
): Promise<SkillDeleteServiceInput> {
  const providerRootOverrides = await dependencies.resolveProviderRootOverrides?.(target)
  return {
    request,
    target,
    repos: dependencies.repos(),
    ...(providerRootOverrides ? { providerRootOverrides } : {}),
    // The allow-list starts empty on purpose: the plan authorizes the rebuilt
    // discovery root set, which is wider than the installable-provider roots the
    // factory would seed.
    filesystem:
      target.kind === 'wsl'
        ? new WslSkillInstallFilesystem(target.distro, [])
        : nativeSkillInstallFilesystem,
    stateDirectory: join(dependencies.userDataPath, 'skill-installs'),
    wslDistro: target.kind === 'wsl' ? target.distro : null
  }
}

export async function previewSkillDeleteRequest(
  request: SkillDeleteRequest,
  target: ResolvedSkillDiscoveryTarget,
  dependencies: SkillDeleteRequestDependencies
): Promise<SkillDeletePlan> {
  return previewSkillDeletion(await serviceInput(request, target, dependencies))
}

export async function runSkillDeleteRequest(
  request: SkillDeleteRequest,
  target: ResolvedSkillDiscoveryTarget,
  dependencies: SkillDeleteRequestDependencies
): Promise<SkillDeleteResult> {
  return deleteSkills(await serviceInput(request, target, dependencies))
}
