import { mkdir, realpath, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { SkillPlacementResult } from '../../shared/skill-install-contract'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import type { SkillProviderDestination } from './skill-provider-destinations'
import {
  nativeSkillInstallFilesystem,
  type SkillInstalledFileMode,
  type SkillInstallFilesystem
} from './skill-install-filesystem'
import {
  createSkillPlacementCopyAtMissingDestination,
  replaceIndependentSkillPlacementCopy
} from './skill-placement-copy'
import { startSkillPhaseOperation } from './skill-operation-observability'
import {
  decideSkillProviderPlacement,
  type SkillPlacementDecision
} from './skill-placement-decision'

type PlacementObservation = { copyFallback: boolean }

function placementFailure(code: string, retryable = false) {
  return {
    errorCategory: code,
    failure: { category: 'provider-placement' as const, code, retryable }
  }
}

async function createProviderAlias(
  canonicalPath: string,
  destinationPath: string,
  filesystem: SkillInstallFilesystem
): Promise<void> {
  if (filesystem.createAlias) {
    await filesystem.createAlias(canonicalPath, destinationPath)
    return
  }
  const parent = dirname(destinationPath)
  await mkdir(parent, { recursive: true })
  if (process.platform === 'win32') {
    await symlink(resolve(canonicalPath), destinationPath, 'junction')
    return
  }
  const realParent = await realpath(parent).catch(() => resolve(parent))
  const realCanonical = await realpath(canonicalPath)
  await symlink(relative(realParent, realCanonical), destinationPath, 'dir')
}

async function applyPlacementDecision(
  decision: SkillPlacementDecision,
  input: {
    canonicalPath: string
    destinationPath: string
    destination: SkillProviderDestination
    filesystem: SkillInstallFilesystem
    fileModes?: readonly SkillInstalledFileMode[]
    observation: PlacementObservation
    transaction?: { stagingPath: string; backupPath: string }
  }
): Promise<SkillPlacementResult> {
  const placement = { provider: input.destination.provider, path: input.destinationPath }
  switch (decision.action) {
    case 'create':
      return createMissingPlacement(input)
    case 'relink':
      await input.filesystem.remove(input.destinationPath)
      return createMissingPlacement({ ...input, transaction: undefined })
    case 'replace-copy':
      return replaceIndependentSkillPlacementCopy(input)
    case 'keep':
      return { ...placement, topology: decision.topology, status: 'unchanged' }
    case 'skip':
      return {
        ...placement,
        topology: decision.topology,
        status: 'skipped',
        ...placementFailure(decision.code)
      }
  }
}

async function createMissingPlacement(input: {
  canonicalPath: string
  destinationPath: string
  destination: SkillProviderDestination
  filesystem: SkillInstallFilesystem
  fileModes?: readonly SkillInstalledFileMode[]
  observation: PlacementObservation
  transaction?: { stagingPath: string; backupPath: string }
}): Promise<SkillPlacementResult> {
  try {
    await createProviderAlias(input.canonicalPath, input.destinationPath, input.filesystem)
    return {
      provider: input.destination.provider,
      path: input.destinationPath,
      topology: 'provider-alias',
      status: 'installed'
    }
  } catch {
    input.observation.copyFallback = true
    try {
      await createSkillPlacementCopyAtMissingDestination(
        input.canonicalPath,
        input.destinationPath,
        input.filesystem,
        input.fileModes,
        input.transaction?.stagingPath
      )
      return {
        provider: input.destination.provider,
        path: input.destinationPath,
        topology: 'independent-copy',
        status: 'installed'
      }
    } catch {
      return {
        provider: input.destination.provider,
        path: input.destinationPath,
        topology: 'independent-copy',
        status: 'failed',
        ...placementFailure('skill-placement-create-failed', true)
      }
    }
  }
}

export async function reconcileSkillProviderPlacement(input: {
  canonicalPath: string
  skillName: string
  destination: SkillProviderDestination
  previousReceipt: SkillInstallReceiptV1 | null
  packageDigest: string
  filesystem?: SkillInstallFilesystem
  fileModes?: readonly SkillInstalledFileMode[]
  targetPlatform?: 'darwin' | 'linux' | 'win32' | 'other'
  transaction?: { stagingPath: string; backupPath: string }
  adoptableDigests?: readonly string[]
}): Promise<SkillPlacementResult | null> {
  if (input.destination.readsCanonicalRoot) {
    return null
  }
  const destinationPath = join(input.destination.rootPath, input.skillName)
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const observation: PlacementObservation = { copyFallback: false }
  const operation = startSkillPhaseOperation({
    phase: 'placement',
    platform: input.targetPlatform,
    destination: 'provider-placement',
    provider: input.destination.provider
  })
  try {
    const decision = await decideSkillProviderPlacement({
      canonicalPath: input.canonicalPath,
      destinationPath,
      provider: input.destination.provider,
      previousReceipt: input.previousReceipt,
      packageDigest: input.packageDigest,
      filesystem,
      fileModes: input.fileModes,
      adoptableDigests: input.adoptableDigests
    })
    const result = await applyPlacementDecision(decision, {
      ...input,
      destinationPath,
      filesystem,
      observation
    })
    operation.complete({
      status: result.status,
      errorCategory: result.errorCategory ?? 'none',
      topology: result.topology,
      aliasMechanism:
        result.topology !== 'provider-alias'
          ? 'none'
          : filesystem.createAlias
            ? 'filesystem'
            : process.platform === 'win32'
              ? 'junction'
              : 'symlink',
      copyFallbackCount: observation.copyFallback ? 1 : 0
    })
    return result
  } catch {
    const result: SkillPlacementResult = {
      provider: input.destination.provider,
      path: destinationPath,
      topology: 'independent-copy',
      status: 'failed',
      ...placementFailure('skill-placement-reconciliation-failed', true)
    }
    operation.complete({
      status: result.status,
      errorCategory: result.errorCategory,
      topology: result.topology,
      aliasMechanism: 'none',
      copyFallbackCount: observation.copyFallback ? 1 : 0
    })
    return result
  }
}
