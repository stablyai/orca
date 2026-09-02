import { lstat, mkdir, realpath, symlink } from 'node:fs/promises'
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
  replaceOwnedSkillPlacementCopy
} from './skill-placement-copy'
import { startSkillPhaseOperation } from './skill-operation-observability'

type PlacementObservation = { copyFallback: boolean }

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function placementFailure(code: string, retryable = false) {
  return {
    errorCategory: code,
    failure: { category: 'provider-placement' as const, code, retryable }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => null))
}

function previousPlacement(
  receipt: SkillInstallReceiptV1 | null,
  provider: string,
  path: string
): SkillPlacementResult | null {
  return (
    receipt?.placements.find(
      (placement) =>
        placement.provider === provider &&
        placement.status !== 'failed' &&
        placement.status !== 'skipped' &&
        normalizedPath(placement.path) === normalizedPath(path)
    ) ?? null
  )
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

async function reconcileExistingPlacement(input: {
  canonicalPath: string
  destinationPath: string
  destination: SkillProviderDestination
  previousReceipt: SkillInstallReceiptV1 | null
  packageDigest: string
  filesystem: SkillInstallFilesystem
  fileModes?: readonly SkillInstalledFileMode[]
  observation: PlacementObservation
  transaction?: { stagingPath: string; backupPath: string }
}): Promise<SkillPlacementResult> {
  const previous = previousPlacement(
    input.previousReceipt,
    input.destination.provider,
    input.destinationPath
  )
  if (previous?.topology === 'independent-copy') {
    const observed = await input.filesystem
      .observeSkill(input.destinationPath, input.previousReceipt?.fileModes)
      .catch(() => null)
    if (!observed || observed.observedDigest !== input.previousReceipt?.packageDigest) {
      return {
        provider: input.destination.provider,
        path: input.destinationPath,
        topology: 'independent-copy',
        status: 'skipped',
        ...placementFailure('skill-placement-modified-copy')
      }
    }
    if (observed.observedDigest === input.packageDigest) {
      return {
        provider: input.destination.provider,
        path: input.destinationPath,
        topology: 'independent-copy',
        status: 'unchanged'
      }
    }
    await replaceOwnedSkillPlacementCopy(
      input.canonicalPath,
      input.destinationPath,
      input.filesystem,
      input.fileModes,
      input.transaction
        ? {
            replacementPath: input.transaction.stagingPath,
            backupPath: input.transaction.backupPath,
            retainBackup: true
          }
        : undefined
    )
    return {
      provider: input.destination.provider,
      path: input.destinationPath,
      topology: 'independent-copy',
      status: 'installed'
    }
  }
  if (input.filesystem.aliasTargets) {
    return (await input.filesystem.aliasTargets(input.canonicalPath, input.destinationPath))
      ? {
          provider: input.destination.provider,
          path: input.destinationPath,
          topology: 'provider-alias',
          status: 'unchanged'
        }
      : {
          provider: input.destination.provider,
          path: input.destinationPath,
          topology: 'provider-alias',
          status: 'skipped',
          ...placementFailure('skill-placement-unowned-link')
        }
  }
  const resolvedDestination = await realpath(input.destinationPath).catch(() => null)
  const resolvedCanonical = await realpath(input.canonicalPath).catch(() => input.canonicalPath)
  if (
    resolvedDestination &&
    normalizedPath(resolvedDestination) === normalizedPath(resolvedCanonical)
  ) {
    return {
      provider: input.destination.provider,
      path: input.destinationPath,
      topology: 'provider-alias',
      status: 'unchanged'
    }
  }
  const stat = await lstat(input.destinationPath)
  if (stat.isSymbolicLink()) {
    if (!resolvedDestination && previous?.topology === 'provider-alias') {
      await input.filesystem.remove(input.destinationPath)
      return createMissingPlacement({
        canonicalPath: input.canonicalPath,
        destinationPath: input.destinationPath,
        destination: input.destination,
        filesystem: input.filesystem,
        fileModes: input.fileModes,
        observation: input.observation
      })
    }
    return {
      provider: input.destination.provider,
      path: input.destinationPath,
      topology: 'provider-alias',
      status: 'skipped',
      ...placementFailure('skill-placement-unowned-link')
    }
  }
  return {
    provider: input.destination.provider,
    path: input.destinationPath,
    topology: 'independent-copy',
    status: 'skipped',
    ...placementFailure('skill-placement-unowned')
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
    const aliasExists = filesystem.aliasTargets
      ? await filesystem.aliasTargets(input.canonicalPath, destinationPath).catch(() => false)
      : false
    const result =
      aliasExists || (await pathExists(destinationPath))
        ? await reconcileExistingPlacement({
            ...input,
            destinationPath,
            filesystem,
            observation
          })
        : await createMissingPlacement({ ...input, destinationPath, filesystem, observation })
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
