import { lstat, readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { SkillPackageManifestV1 } from '../../shared/skill-package-manifest'
import type { SkillInstallReceiptV1 } from './skill-install-provenance'
import {
  nativeSkillInstallFilesystem,
  type SkillInstallFilesystem,
  type SkillInstalledFileMode
} from './skill-install-filesystem'

export type SkillCanonicalState =
  | { kind: 'missing' }
  | { kind: 'unchanged'; digest: string }
  | { kind: 'clean-update'; digest: string }
  | { kind: 'modified'; digest?: string }
  | { kind: 'unowned'; digest?: string }
  | { kind: 'external-link' }
  | { kind: 'name-collision' }

export async function inspectSkillCanonicalState(input: {
  canonicalPath: string
  manifest: SkillPackageManifestV1
  receipt: SkillInstallReceiptV1 | null
  filesystem?: SkillInstallFilesystem
}): Promise<SkillCanonicalState> {
  const filesystem = input.filesystem ?? nativeSkillInstallFilesystem
  const requestedName = basename(input.canonicalPath)
  const siblingNames = await readdir(dirname(input.canonicalPath)).catch(() => [])
  if (
    siblingNames.some(
      (name) =>
        name !== requestedName &&
        name.toLocaleLowerCase('en-US') === requestedName.toLocaleLowerCase('en-US')
    )
  ) {
    return { kind: 'name-collision' }
  }
  const destinationStat = await lstat(input.canonicalPath).catch(() => null)
  if (!destinationStat) {
    return { kind: 'missing' }
  }
  if (destinationStat.isSymbolicLink()) {
    return { kind: 'external-link' }
  }
  if (!destinationStat.isDirectory()) {
    return { kind: 'name-collision' }
  }
  const observe = async (files?: readonly SkillInstalledFileMode[]): Promise<string | undefined> =>
    filesystem
      .observeSkill(input.canonicalPath, files)
      .then((value) => value.observedDigest)
      .catch(() => undefined)
  const receiptDigest = input.receipt
    ? await observe(input.receipt.fileModes ?? input.manifest.files)
    : undefined
  if (input.receipt && receiptDigest === input.receipt.packageDigest) {
    return receiptDigest === input.manifest.packageDigest
      ? { kind: 'unchanged', digest: receiptDigest }
      : { kind: 'clean-update', digest: receiptDigest }
  }
  const requestedDigest = await observe(input.manifest.files)
  if (requestedDigest === input.manifest.packageDigest) {
    return { kind: 'unchanged', digest: requestedDigest }
  }
  if (!input.receipt) {
    return requestedDigest ? { kind: 'unowned', digest: requestedDigest } : { kind: 'unowned' }
  }
  return requestedDigest ? { kind: 'modified', digest: requestedDigest } : { kind: 'modified' }
}
