import { join } from 'node:path'
import type { SkillInstallResult } from '../../../shared/skill-install-contract'
import { SKILL_INSTALL_PROVIDERS } from '../../../shared/skill-install-providers'
import {
  resolveSkillProviderDestinations,
  type SkillProviderRootOverrides
} from '../providers/skill-provider-destinations'
import type { SkillInstallFilesystem } from '../filesystem/skill-install-filesystem'
import { canonicalRoot } from '../install/skill-install-paths'
import { removeLocalSharedSkill } from './skill-remove-transaction'

export type SkillRemoveServiceInput = {
  operationId: string
  skillName: string
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  orcaStateDirectory: string
  detectedProviders: readonly string[]
  providerRootOverrides?: SkillProviderRootOverrides
  conflictResolution?: 'replace-and-discard-local' | 'cancel'
  filesystem?: SkillInstallFilesystem
}

export async function removeSharedSkill(
  input: SkillRemoveServiceInput
): Promise<SkillInstallResult> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.skillName)) {
    throw new Error('skill-install-name-invalid')
  }
  const providerDestinations = resolveSkillProviderDestinations({
    scope: input.scope,
    homeDirectory: input.homeDirectory,
    workspaceDirectory: input.workspaceDirectory,
    detectedProviders: SKILL_INSTALL_PROVIDERS.map((provider) => provider.id),
    providerRootOverrides: input.providerRootOverrides
  })
  return removeLocalSharedSkill({
    operationId: input.operationId,
    canonicalPath: join(canonicalRoot(input), input.skillName),
    stateDirectory: join(input.orcaStateDirectory, 'skill-installs'),
    allowedProviderRoots: providerDestinations
      .filter((destination) => !destination.readsCanonicalRoot)
      .map((destination) => destination.rootPath),
    conflictResolution: input.conflictResolution,
    filesystem: input.filesystem
  })
}
