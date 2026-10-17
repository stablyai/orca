import { join } from 'node:path'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import {
  installLocalExtractedSkillPackage,
  installLocalSkillPackage,
  type LocalExtractedSkillPackage,
  type LocalSkillInstallInput,
  type LocalSkillInstallTarget,
  previewLocalSkillPackage
} from './skill-install-transaction'
import {
  resolveSkillProviderDestinations,
  type SkillProviderRootOverrides
} from './skill-provider-destinations'
import { removeLocalSharedSkill } from './skill-remove-transaction'
import type { SkillInstallFilesystem } from './skill-install-filesystem'
import { verifySkillInstallDiscovery } from './skill-install-discovery-verification'
import type { SkillDiscoveryResult } from '../../shared/skills'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import { createSkillPlacementTransaction } from './skill-placement-transaction-controller'

export type SkillInstallServiceInput = Omit<
  LocalSkillInstallInput,
  'destinationRoot' | 'stateDirectory' | 'scope'
> & {
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
  orcaStateDirectory: string
  detectedProviders: readonly string[]
  providerRootOverrides?: SkillProviderRootOverrides
  filesystem?: SkillInstallFilesystem
  wslDistro?: string
  discover?: () => Promise<SkillDiscoveryResult>
  /** Receives discovery's diagnostic line; defaults to console.info. */
  discoveryLog?: (line: string) => void
  signal?: AbortSignal
}

/** Install input for a package already staged on disk, which has no archive to verify. */
export type SkillInstallTargetInput = Omit<
  SkillInstallServiceInput,
  'archivePath' | 'expectedArchiveSha256'
>

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

function canonicalRoot(input: {
  scope: 'global' | 'workspace'
  homeDirectory: string
  workspaceDirectory?: string
}): string {
  const scopeRoot = input.scope === 'global' ? input.homeDirectory : input.workspaceDirectory
  if (!scopeRoot) {
    throw new Error('skill-install-workspace-required')
  }
  return join(scopeRoot, '.agents', 'skills')
}

export function skillInstallLocalInput(input: SkillInstallServiceInput): LocalSkillInstallInput {
  return {
    ...skillInstallLocalTarget(input),
    archivePath: input.archivePath,
    expectedArchiveSha256: input.expectedArchiveSha256
  }
}

export function skillInstallLocalTarget(input: SkillInstallTargetInput): LocalSkillInstallTarget {
  return {
    operationId: input.operationId,
    destinationRoot: canonicalRoot(input),
    stateDirectory: join(input.orcaStateDirectory, 'skill-installs'),
    scope: input.scope,
    destinationIdentity: input.destinationIdentity,
    hostIdentity: input.hostIdentity,
    expectedPackageDigest: input.expectedPackageDigest,
    expectedPackageId: input.expectedPackageId,
    expectedVersionId: input.expectedVersionId,
    sourceBundleDigest: input.sourceBundleDigest,
    conflictResolution: input.conflictResolution,
    adoptableDigests: input.adoptableDigests,
    filesystem: input.filesystem,
    wslDistro: input.wslDistro,
    signal: input.signal
  }
}

function placementTransaction(input: SkillInstallTargetInput, request: LocalSkillInstallTarget) {
  return createSkillPlacementTransaction({
    stateDirectory: request.stateDirectory,
    scope: input.scope,
    homeDirectory: input.homeDirectory,
    workspaceDirectory: input.workspaceDirectory,
    detectedProviders: input.detectedProviders,
    providerRootOverrides: input.providerRootOverrides,
    filesystem: input.filesystem,
    wslDistro: input.wslDistro,
    adoptableDigests: input.adoptableDigests,
    signal: input.signal
  })
}

export async function installSharedSkill(
  input: SkillInstallServiceInput
): Promise<SkillInstallResult> {
  const request = skillInstallLocalInput(input)
  await previewLocalSkillPackage(request)
  const result = await installLocalSkillPackage(request, {
    placementTransaction: placementTransaction(input, request)
  })
  return completeSharedSkillInstall(input, result)
}

export async function installSharedExtractedSkill(
  input: SkillInstallTargetInput,
  extracted: LocalExtractedSkillPackage
): Promise<SkillInstallResult> {
  const request = skillInstallLocalTarget(input)
  const result = await installLocalExtractedSkillPackage(request, extracted, {
    placementTransaction: placementTransaction(input, request)
  })
  return completeSharedSkillInstall(input, result)
}

async function completeSharedSkillInstall(
  input: SkillInstallTargetInput,
  result: SkillInstallResult
): Promise<SkillInstallResult> {
  if (
    !result.canonicalPath ||
    result.status === 'conflict' ||
    result.status === 'failed' ||
    result.status === 'cancelled'
  ) {
    return result
  }
  const incomplete = result.placements.some(
    (placement) => placement.status === 'failed' || placement.status === 'skipped'
  )
  return verifySkillInstallDiscovery({
    result: { ...result, status: incomplete ? 'partial' : result.status },
    scope: input.scope,
    homeDirectory: input.homeDirectory,
    workspaceDirectory: input.workspaceDirectory,
    wslDistro: input.wslDistro,
    providerRootOverrides: input.providerRootOverrides,
    discover: input.discover,
    log: input.discoveryLog
  })
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
