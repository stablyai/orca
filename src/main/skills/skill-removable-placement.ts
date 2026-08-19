import { lstat, readlink } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { SkillPlacementResult } from '../../shared/skill-install-contract'
import type { SkillInstallFilesystem } from './skill-install-filesystem'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized
}

function pathInside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path))
  return (
    child !== '' &&
    child !== '..' &&
    !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(child)
  )
}

async function aliasTargetsCanonical(path: string, canonicalPath: string): Promise<boolean> {
  const target = await readlink(path).catch(() => null)
  return Boolean(
    target && normalizedPath(resolve(dirname(path), target)) === normalizedPath(canonicalPath)
  )
}

export async function isRemovableSkillPlacement(input: {
  placement: SkillPlacementResult
  receipt: SkillInstallReceiptV1
  allowedProviderRoots: readonly string[]
  filesystem: SkillInstallFilesystem
}): Promise<boolean> {
  if (
    input.placement.topology === 'canonical-copy' ||
    input.placement.status === 'failed' ||
    input.placement.status === 'skipped'
  ) {
    return false
  }
  if (
    !input.allowedProviderRoots.some(
      (root) =>
        pathInside(root, input.placement.path) &&
        normalizedPath(input.placement.path) ===
          normalizedPath(join(root, basename(input.receipt.canonicalPath)))
    )
  ) {
    return false
  }
  if (input.placement.topology === 'provider-alias' && input.filesystem.aliasTargets) {
    return input.filesystem.aliasTargets(input.receipt.canonicalPath, input.placement.path)
  }
  const stat = await lstat(input.placement.path).catch(() => null)
  if (!stat) {
    return false
  }
  if (input.placement.topology === 'provider-alias') {
    return (
      stat.isSymbolicLink() &&
      aliasTargetsCanonical(input.placement.path, input.receipt.canonicalPath)
    )
  }
  if (!stat.isDirectory()) {
    return false
  }
  const observed = await input.filesystem
    .observeSkill(input.placement.path, input.receipt.fileModes)
    .catch(() => null)
  return observed?.observedDigest === input.receipt.packageDigest
}
