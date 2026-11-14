import type { LocalExtractedSkillPackage } from './skill-extracted-package-inspection'
import { canonicalRoot } from './skill-install-paths'

import { join } from 'node:path'
import type { SkillInstallResult } from '../../../shared/skill-install-contract'
import {
  installLocalExtractedSkillPackage,
  installLocalSkillPackage,
  type LocalSkillInstallInput,
  previewLocalSkillPackage
} from './skill-install-transaction'
import type { SkillProviderRootOverrides } from '../providers/skill-provider-destinations'

import type { SkillInstallFilesystem } from '../filesystem/skill-install-filesystem'
import { verifySkillInstallDiscovery } from './skill-install-discovery-verification'

import { createSkillPlacementTransaction } from '../provider-placement/skill-placement-transaction-controller'

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
  signal?: AbortSignal
}

export function skillInstallLocalInput(input: SkillInstallServiceInput): LocalSkillInstallInput {
  return {
    operationId: input.operationId,
    archivePath: input.archivePath,
    destinationRoot: canonicalRoot(input),
    stateDirectory: join(input.orcaStateDirectory, 'skill-installs'),
    scope: input.scope,
    destinationIdentity: input.destinationIdentity,
    hostIdentity: input.hostIdentity,
    expectedArchiveSha256: input.expectedArchiveSha256,
    expectedPackageDigest: input.expectedPackageDigest,
    expectedPackageId: input.expectedPackageId,
    expectedVersionId: input.expectedVersionId,
    sourceBundleDigest: input.sourceBundleDigest,
    conflictResolution: input.conflictResolution,
    filesystem: input.filesystem,
    wslDistro: input.wslDistro,
    signal: input.signal
  }
}

function placementTransaction(input: SkillInstallServiceInput, request: LocalSkillInstallInput) {
  return createSkillPlacementTransaction({
    stateDirectory: request.stateDirectory,
    scope: input.scope,
    homeDirectory: input.homeDirectory,
    workspaceDirectory: input.workspaceDirectory,
    detectedProviders: input.detectedProviders,
    providerRootOverrides: input.providerRootOverrides,
    filesystem: input.filesystem,
    wslDistro: input.wslDistro,
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
  input: SkillInstallServiceInput,
  extracted: LocalExtractedSkillPackage
): Promise<SkillInstallResult> {
  const request = skillInstallLocalInput(input)
  const result = await installLocalExtractedSkillPackage(request, extracted, {
    placementTransaction: placementTransaction(input, request)
  })
  return completeSharedSkillInstall(input, result)
}

async function completeSharedSkillInstall(
  input: SkillInstallServiceInput,
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
    providerRootOverrides: input.providerRootOverrides
  })
}
