import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { skillDirectoryMaxDepth } from '../../../shared/skill-discovery-depth'
import type { SkillPathSemantics } from '../../../shared/skill-path-containment'
import type { SkillScanRoot } from '../skill-discovery-sources'
import type { SkillInstallFilesystem, SkillPathInspection } from '../skill-install-filesystem'
import { SKILL_FILE_NAME } from '../skill-root-file-walk'
import { isSkillStagingEntryName } from './staging-names'

/** One directory in a discovery root that holds a `SKILL.md`, with everything
 *  the classifier needs to decide which of the three placement kinds it is. */
export type SkillPlacementCandidate = {
  path: string
  root: SkillScanRoot
  /** `lstat` kind of the directory entry itself — a symlink here is an alias. */
  entryKind: 'directory' | 'symlink'
  /** `lstat` kind of the `SKILL.md` inside it. */
  skillFileKind: 'file' | 'symlink'
  directoryRealpath: string | null
  skillFileRealpath: string | null
}

export class SkillDeleteEnumerationUnsupportedError extends Error {
  constructor() {
    super('skill-delete-filesystem-cannot-enumerate')
    this.name = 'SkillDeleteEnumerationUnsupportedError'
  }
}

type Enumerable = Required<Pick<SkillInstallFilesystem, 'listEntries' | 'inspectPaths'>>

export function requireEnumerableFilesystem(filesystem: SkillInstallFilesystem): Enumerable {
  if (!filesystem.listEntries || !filesystem.inspectPaths) {
    throw new SkillDeleteEnumerationUnsupportedError()
  }
  // Bound, not detached: the WSL filesystem's `listEntries` reaches `this.runOutput`.
  return {
    listEntries: filesystem.listEntries.bind(filesystem),
    inspectPaths: filesystem.inspectPaths.bind(filesystem)
  }
}

/**
 * Breadth-first so every level costs one batched round trip rather than one per
 * directory — the bound that keeps a WSL plan to a handful of `wsl.exe` boots
 * instead of hundreds.
 *
 * Plugin roots are deliberately not walked: they nest up to ten levels, and a
 * plugin skill is blocked from the canonical path alone (see the guards), so
 * paying for that walk would buy nothing.
 */
export async function enumerateSkillPlacementCandidates(input: {
  roots: readonly SkillScanRoot[]
  filesystem: SkillInstallFilesystem
  semantics: SkillPathSemantics
  toFilesystemPath: (path: string) => string
}): Promise<SkillPlacementCandidate[]> {
  const { listEntries, inspectPaths } = requireEnumerableFilesystem(input.filesystem)
  const api = input.semantics.sep === '\\' ? pathWin32 : pathPosix
  const walkable = input.roots.filter((root) => root.sourceKind !== 'plugin')
  const candidates: SkillPlacementCandidate[] = []
  const inspectionTargets = new Set<string>()
  let frontier = dedupeByPath(walkable.map((root) => ({ root, path: root.path, depth: 0 })))

  while (frontier.length > 0) {
    const listings = await listEntries(frontier.map((entry) => input.toFilesystemPath(entry.path)))
    const next: typeof frontier = []
    for (const current of frontier) {
      const entries = listings.get(input.toFilesystemPath(current.path)) ?? []
      const skillFile = entries.find((entry) => entry.name === SKILL_FILE_NAME)
      // The root itself is never a placement, only the directories below it.
      if (current.depth > 0 && (skillFile?.kind === 'file' || skillFile?.kind === 'symlink')) {
        candidates.push({
          path: current.path,
          root: current.root,
          entryKind: 'directory',
          skillFileKind: skillFile.kind,
          directoryRealpath: null,
          skillFileRealpath: null
        })
        inspectionTargets.add(current.path)
        inspectionTargets.add(api.join(current.path, SKILL_FILE_NAME))
      }
      for (const entry of entries) {
        if (entry.kind !== 'directory' && entry.kind !== 'symlink') {
          continue
        }
        // The SKILL.md of this directory is already accounted for above; as a
        // child entry it can only ever be a file, never a placement.
        if (entry.name === SKILL_FILE_NAME || isSkillStagingEntryName(entry.name)) {
          continue
        }
        const childPath = api.join(current.path, entry.name)
        if (entry.kind === 'symlink') {
          // A symlinked directory is an alias candidate on its own, and is not
          // descended into: its contents belong to whatever it points at.
          candidates.push({
            path: childPath,
            root: current.root,
            entryKind: 'symlink',
            skillFileKind: 'file',
            directoryRealpath: null,
            skillFileRealpath: null
          })
          inspectionTargets.add(childPath)
          inspectionTargets.add(api.join(childPath, SKILL_FILE_NAME))
          continue
        }
        if (current.depth + 1 <= skillDirectoryMaxDepth(current.root.sourceKind)) {
          next.push({ root: current.root, path: childPath, depth: current.depth + 1 })
        }
      }
    }
    // Two roots can share a path — `~/.claude/skills` is both a home root and a
    // repo root when the home directory is the workspace — so without this the
    // same directory is walked (and later staged) twice.
    frontier = dedupeByPath(next)
  }

  const inspections = await resolveInspections(inspectPaths, inspectionTargets, input)
  return candidates
    .map((candidate) => {
      const directory = inspections.get(candidate.path)
      const skillFile = inspections.get(api.join(candidate.path, SKILL_FILE_NAME))
      return {
        ...candidate,
        entryKind: directory?.kind === 'symlink' ? ('symlink' as const) : candidate.entryKind,
        skillFileKind:
          skillFile?.kind === 'symlink' ? ('symlink' as const) : candidate.skillFileKind,
        directoryRealpath: directory?.realpath ?? null,
        skillFileRealpath: skillFile?.realpath ?? null
      }
    })
    .filter(
      (candidate) => candidate.skillFileRealpath !== null || candidate.entryKind === 'symlink'
    )
}

function dedupeByPath<T extends { path: string }>(entries: readonly T[]): T[] {
  const seen = new Set<string>()
  return entries.filter((entry) => {
    if (seen.has(entry.path)) {
      return false
    }
    seen.add(entry.path)
    return true
  })
}

async function resolveInspections(
  inspectPaths: Enumerable['inspectPaths'],
  targets: ReadonlySet<string>,
  input: { toFilesystemPath: (path: string) => string }
): Promise<Map<string, SkillPathInspection>> {
  const ordered = [...targets]
  const raw = await inspectPaths(ordered.map((path) => input.toFilesystemPath(path)))
  return new Map(
    ordered.flatMap((path) => {
      const inspection = raw.get(input.toFilesystemPath(path))
      return inspection ? [[path, inspection] as const] : []
    })
  )
}
