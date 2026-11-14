import { join } from 'node:path'
import type { SkillInstallResult, SkillRemoveRequest } from '../../../shared/skill-install-contract'
import { SKILL_INSTALL_PROVIDERS } from '../../../shared/skill-install-providers'
import { resolveSkillInstallDestination } from '../install/skill-install-destinations'
import type { ManagementDependencies } from '../install/skill-install-preview'
import { canonicalPath } from '../install/skill-install-paths'
import { resolveSkillProviderDestinations } from '../providers/skill-provider-destinations'
import { createWslSkillInstallFilesystem } from '../filesystem/skill-wsl-install-filesystem'
import { removeLocalSharedSkill } from './skill-remove-transaction'

export async function removeSharedSkillInstall(
  request: SkillRemoveRequest,
  dependencies: ManagementDependencies
): Promise<SkillInstallResult> {
  const destination = await resolveSkillInstallDestination(
    request.destination,
    dependencies.authority
  )
  const providerRootOverrides = await dependencies.resolveProviderRootOverrides?.(destination)
  const filesystem = destination.wslDistro
    ? createWslSkillInstallFilesystem({
        distro: destination.wslDistro,
        homeDirectory: destination.homeDirectory,
        workspaceDirectory: destination.workspaceDirectory,
        providerRootOverrides
      })
    : undefined
  const providerRoots = resolveSkillProviderDestinations({
    scope: destination.scope,
    homeDirectory: destination.homeDirectory,
    workspaceDirectory: destination.workspaceDirectory,
    detectedProviders: SKILL_INSTALL_PROVIDERS.map((provider) => provider.id),
    providerRootOverrides
  }).map((provider) => provider.rootPath)
  return removeLocalSharedSkill({
    operationId: request.operationId,
    canonicalPath: canonicalPath(destination, request.name),
    stateDirectory: join(dependencies.stateDirectory, 'skill-installs'),
    allowedProviderRoots: providerRoots,
    conflictResolution: request.conflictResolution,
    filesystem
  })
}
