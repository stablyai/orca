import { join } from 'node:path'
import type {
  BundledSkillCleanup,
  BundledSkillObserved,
  BundledSkillOp
} from '../../../shared/skills/bundled/bundled-skill-plan'
import type { BundledSkillSource } from './bundled-skill-sources'
import { classifyBundledSkillPath, isShippedBundledSkillFile } from './bundled-skill-classification'
import type { BundledSkillFilesystem } from './bundled-skill-filesystem'
import { bundledSkillFileSiblingKind, bundledSkillSiblingKind } from './bundled-skill-folder-swap'
import type { BundledSkillTargetRoot } from './bundled-skill-targets'

export async function recoverySiblings(
  filesystem: BundledSkillFilesystem,
  source: BundledSkillSource,
  digest: string,
  root: BundledSkillTargetRoot,
  targetIsAbsent: boolean,
  /** The target folder, whose interrupted in-place SKILL.md update leftovers are cleaned too. */
  skillFolder?: string
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
  if (skillFolder) {
    cleanup.push(...(await strayFileSiblings(filesystem, skillFolder, source, digest)))
  }
  return {
    ...(restore ? { restoreFrom: { path: restore.path, observed: restore.observed } } : {}),
    cleanup
  }
}

/** Only Orca writes these names: a stage is always disposable, a replaced SKILL.md only when shipped. */
async function strayFileSiblings(
  filesystem: BundledSkillFilesystem,
  folder: string,
  source: BundledSkillSource,
  digest: string
): Promise<BundledSkillCleanup[]> {
  const cleanup: BundledSkillCleanup[] = []
  const entries = (await filesystem.listEntries(folder)) ?? []
  for (const entry of entries) {
    const kind = entry.kind === 'file' ? bundledSkillFileSiblingKind(entry.name) : null
    const path = join(folder, entry.name)
    const stat = kind ? await filesystem.stat(path) : null
    if (stat?.kind !== 'file') {
      continue
    }
    const disposable =
      kind === 'stage' || (await isShippedBundledSkillFile(filesystem, path, source, digest))
    cleanup.push({
      path,
      action: disposable ? 'delete' : 'backup',
      observed: { kind: 'file', mtimeMs: stat.mtimeMs }
    })
  }
  // A folder Orca cannot write keeps its leftovers rather than failing every run.
  return cleanup.length > 0 && (await filesystem.canWrite(folder))
    ? cleanup.sort((left, right) => (left.path < right.path ? -1 : 1))
    : []
}
