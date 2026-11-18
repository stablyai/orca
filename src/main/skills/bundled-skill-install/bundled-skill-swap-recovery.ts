import { join } from 'node:path'
import type {
  BundledSkillCleanup,
  BundledSkillObserved,
  BundledSkillOp
} from '../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import { classifyBundledSkillPath } from './bundled-skill-classification'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'
import { bundledSkillSiblingKind, isBundledSkillFileStage } from './bundled-skill-folder-swap'
import type { BundledSkillTargetRoot } from './bundled-skill-targets'

export async function recoverySiblings(
  filesystem: BundledSkillFilesystem,
  source: BundledSkillSource,
  digest: string,
  root: BundledSkillTargetRoot,
  targetIsAbsent: boolean,
  /** A target holding a shipped SKILL.md, whose interrupted in-place update stages are cleaned too. */
  shippedFolder?: string
): Promise<{ restoreFrom?: BundledSkillOp['restoreFrom']; cleanup: BundledSkillCleanup[] }> {
  const listing = (await filesystem.listEntries(root.path)) ?? []
  const cleanup: BundledSkillCleanup[] = []
  const olds: { path: string; observed: BundledSkillObserved; wholeFolderClass: string }[] = []
  for (const entry of [...listing].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const kind = bundledSkillSiblingKind(source.name, entry.name)
    const path = join(root.path, entry.name)
    if (!kind) {
      continue
    }
    const classified = await classifyBundledSkillPath(filesystem, path, source, digest, true)
    if (classified.observed.kind === 'unreadable') {
      continue
    }
    if (kind === 'stage') {
      cleanup.push({ path, action: 'delete', observed: classified.observed })
    } else {
      olds.push({ path, ...classified })
    }
  }
  const restore = targetIsAbsent ? olds.shift() : undefined
  for (const old of olds) {
    // Anything beside SKILL.md makes the old copy the user's: back it up, never delete it.
    const released = old.wholeFolderClass === 'current' || old.wholeFolderClass === 'released'
    cleanup.push({ path: old.path, action: released ? 'delete' : 'backup', observed: old.observed })
  }
  if (shippedFolder) {
    cleanup.push(...(await strayFileStages(filesystem, shippedFolder)))
  }
  return {
    ...(restore ? { restoreFrom: { path: restore.path, observed: restore.observed } } : {}),
    cleanup
  }
}

/** Only Orca writes these names, so they are always safe to delete. */
async function strayFileStages(
  filesystem: BundledSkillFilesystem,
  folder: string
): Promise<BundledSkillCleanup[]> {
  const cleanup: BundledSkillCleanup[] = []
  for (const entry of (await filesystem.listEntries(folder)) ?? []) {
    if (entry.kind !== 'file' || !isBundledSkillFileStage(entry.name)) {
      continue
    }
    const path = join(folder, entry.name)
    const stat = await filesystem.stat(path)
    if (stat?.kind === 'file') {
      cleanup.push({ path, action: 'delete', observed: { kind: 'file', mtimeMs: stat.mtimeMs } })
    }
  }
  return cleanup.sort((left, right) => (left.path < right.path ? -1 : 1))
}
