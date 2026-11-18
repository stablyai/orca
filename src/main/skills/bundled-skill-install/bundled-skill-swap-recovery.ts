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
  const strays = skillFolder
    ? await strayFileSiblings(filesystem, skillFolder, source, digest)
    : { cleanup: [] }
  cleanup.push(...strays.cleanup)
  const restoreFrom = restore
    ? { path: restore.path, observed: restore.observed }
    : strays.restoreFrom
  return { ...(restoreFrom ? { restoreFrom } : {}), cleanup }
}

/**
 * Only Orca writes these names: a stage is always disposable, a moved-aside SKILL.md only when
 * shipped. A folder an update left without SKILL.md gets its moved-aside copy back.
 */
async function strayFileSiblings(
  filesystem: BundledSkillFilesystem,
  folder: string,
  source: BundledSkillSource,
  digest: string
): Promise<{ restoreFrom?: BundledSkillOp['restoreFrom']; cleanup: BundledSkillCleanup[] }> {
  const entries = (await filesystem.listEntries(folder)) ?? []
  const strays: { path: string; kind: 'stage' | 'old'; observed: BundledSkillObserved }[] = []
  for (const entry of [...entries].sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const kind = entry.kind === 'file' ? bundledSkillFileSiblingKind(entry.name) : null
    const path = join(folder, entry.name)
    const stat = kind ? await filesystem.stat(path) : null
    if (kind && stat?.kind === 'file') {
      strays.push({ path, kind, observed: { kind: 'file', mtimeMs: stat.mtimeMs } })
    }
  }
  // A folder Orca cannot write keeps its leftovers rather than failing every run.
  if (strays.length === 0 || !(await filesystem.canWrite(folder))) {
    return { cleanup: [] }
  }
  const missingSkill = !entries.some((entry) => entry.name === 'SKILL.md')
  const restore = missingSkill ? strays.find((stray) => stray.kind === 'old') : undefined
  const cleanup: BundledSkillCleanup[] = []
  for (const stray of strays) {
    if (stray === restore) {
      continue
    }
    const disposable =
      stray.kind === 'stage' ||
      (await isShippedBundledSkillFile(filesystem, stray.path, source, digest))
    cleanup.push({
      path: stray.path,
      action: disposable ? 'delete' : 'backup',
      observed: stray.observed
    })
  }
  return {
    ...(restore ? { restoreFrom: { path: restore.path, observed: restore.observed } } : {}),
    cleanup
  }
}
