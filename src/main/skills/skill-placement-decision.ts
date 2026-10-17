import { lstat, readlink, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { SkillPlacementResult } from '../../shared/skill-install-contract'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import type { SkillInstalledFileMode, SkillInstallFilesystem } from './skill-install-filesystem'

export type SkillPlacementDecision =
  | { action: 'create' }
  /** A link an earlier Orca install made that no longer resolves; replaced by a new one. */
  | { action: 'relink' }
  | { action: 'replace-copy' }
  | { action: 'keep'; topology: SkillPlacementResult['topology'] }
  | { action: 'skip'; topology: SkillPlacementResult['topology']; code: string }

export type SkillPlacementDecisionInput = {
  canonicalPath: string
  destinationPath: string
  provider: string
  previousReceipt: SkillInstallReceiptV1 | null
  packageDigest: string
  filesystem: SkillInstallFilesystem
  fileModes?: readonly SkillInstalledFileMode[]
  adoptableDigests?: readonly string[]
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function previousPlacement(input: SkillPlacementDecisionInput): SkillPlacementResult | null {
  return (
    input.previousReceipt?.placements.find(
      (placement) =>
        placement.provider === input.provider &&
        placement.status !== 'failed' &&
        placement.status !== 'skipped' &&
        normalizedPath(placement.path) === normalizedPath(input.destinationPath)
    ) ?? null
  )
}

async function observedDigest(input: SkillPlacementDecisionInput, fileModes = input.fileModes) {
  return (
    (await input.filesystem.observeSkill(input.destinationPath, fileModes).catch(() => null))
      ?.observedDigest ?? null
  )
}

/**
 * What installing a skill does to one agent-home path. The install and `--dry-run` both ask
 * this, so a plan cannot promise something the transaction would not do.
 */
export async function decideSkillProviderPlacement(
  input: SkillPlacementDecisionInput
): Promise<SkillPlacementDecision> {
  const aliasExists = input.filesystem.aliasTargets
    ? await input.filesystem
        .aliasTargets(input.canonicalPath, input.destinationPath)
        .catch(() => false)
    : false
  const stat = await lstat(input.destinationPath).catch(() => null)
  if (!aliasExists && !stat) {
    return { action: 'create' }
  }
  const previous = previousPlacement(input)
  if (previous?.topology === 'independent-copy') {
    const digest = await observedDigest(input, input.previousReceipt?.fileModes)
    if (
      !digest ||
      (digest !== input.previousReceipt?.packageDigest && !input.adoptableDigests?.includes(digest))
    ) {
      return { action: 'skip', topology: 'independent-copy', code: 'skill-placement-modified-copy' }
    }
    return digest === input.packageDigest
      ? { action: 'keep', topology: 'independent-copy' }
      : { action: 'replace-copy' }
  }
  if (input.filesystem.aliasTargets) {
    return aliasExists
      ? { action: 'keep', topology: 'provider-alias' }
      : { action: 'skip', topology: 'provider-alias', code: 'skill-placement-unowned-link' }
  }
  const resolvedDestination = await realpath(input.destinationPath).catch(() => null)
  const resolvedCanonical = await realpath(input.canonicalPath).catch(() => input.canonicalPath)
  if (
    resolvedDestination &&
    normalizedPath(resolvedDestination) === normalizedPath(resolvedCanonical)
  ) {
    return { action: 'keep', topology: 'provider-alias' }
  }
  if (stat?.isSymbolicLink()) {
    if (!resolvedDestination) {
      if (previous?.topology === 'provider-alias') {
        return { action: 'relink' }
      }
      // Why: before the canonical copy exists, a link already naming it is the skills CLI
      // layout this install completes, not someone else's link.
      const target = await readlink(input.destinationPath).catch(() => null)
      if (
        target &&
        normalizedPath(resolve(dirname(input.destinationPath), target)) ===
          normalizedPath(input.canonicalPath)
      ) {
        return { action: 'keep', topology: 'provider-alias' }
      }
    }
    return { action: 'skip', topology: 'provider-alias', code: 'skill-placement-unowned-link' }
  }
  // Why: a real folder holding a version the caller owns (e.g. the skills CLI's single-agent
  // layout) is replaced in place; any other bytes are the user's.
  if (input.adoptableDigests?.length) {
    const digest = await observedDigest(input)
    if (digest === input.packageDigest) {
      return { action: 'keep', topology: 'independent-copy' }
    }
    if (digest && input.adoptableDigests.includes(digest)) {
      return { action: 'replace-copy' }
    }
  }
  return { action: 'skip', topology: 'independent-copy', code: 'skill-placement-unowned' }
}
