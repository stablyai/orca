import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import { skillFileMaxDepth } from '../../../shared/skill-discovery-depth'
import type {
  SkillDeleteBlockReason,
  SkillDeletePlacement
} from '../../../shared/skill-delete-contract'
import {
  skillPathDepthBelow,
  skillPathsEqual,
  type SkillPathSemantics
} from '../../../shared/skill-path-containment'
import type { SkillScanRoot } from '../skill-discovery-sources'
import type { SkillPlacementCandidate } from './enumeration'

/**
 * Headroom against ordinary clock and read skew, not against WSL's
 * second-granularity mtime: the displayed value and the host's re-read come
 * from the same `stat` on the same host, so they already agree exactly.
 */
export const SKILL_DELETE_FRESHNESS_TOLERANCE_MS = 1_000

export type SkillDeleteGuardContext = {
  semantics: SkillPathSemantics
  roots: readonly SkillScanRoot[]
}

function pathApi(semantics: SkillPathSemantics): typeof pathPosix {
  return semantics.sep === '\\' ? pathWin32 : pathPosix
}

/**
 * A request carrying no `updatedAt` fails closed. It is reachable on WSL when
 * the guest `stat` fails, and "unknown" is not "unchanged" for a delete.
 */
export function isSkillDeleteFresh(
  displayedUpdatedAt: number | null,
  observedMtimeMs: number | null
): boolean {
  if (displayedUpdatedAt === null || observedMtimeMs === null) {
    return false
  }
  return Math.abs(displayedUpdatedAt - observedMtimeMs) <= SKILL_DELETE_FRESHNESS_TOLERANCE_MS
}

/** The root a path belongs to, honouring depth; null when no root owns it. */
export function owningSkillRoot(
  path: string,
  context: SkillDeleteGuardContext
): SkillScanRoot | null {
  const api = pathApi(context.semantics)
  const skillFilePath = api.join(path, 'SKILL.md')
  for (const root of context.roots) {
    const depth = skillPathDepthBelow(root.path, skillFilePath, context.semantics)
    if (depth !== null && depth <= skillFileMaxDepth(root.sourceKind)) {
      return root
    }
  }
  return null
}

/**
 * Host-side eligibility, re-derived from where the skill actually lives rather
 * than read off the row: `sourceKind` is first-scanned-root-wins, so a
 * plugin-cache or `.system/` skill symlinked into a plain home root reports
 * `home` on the client. The host verdict may be stricter than the badge.
 *
 * A canonical directory *outside* every root is deliberately not blocked here.
 * The rule is "remove every placement Orca owns, and never touch anything
 * outside its roots" — so a tool-managed skill linked into a repo stays
 * deletable by its links, while its content is left alone. When no placement
 * sits inside a root either, the plan reports `unowned` on that basis instead.
 */
export function blockedCanonicalReason(
  canonicalDirectoryPath: string,
  context: SkillDeleteGuardContext
): SkillDeleteBlockReason | null {
  const api = pathApi(context.semantics)
  const canonicalSkillFile = api.join(canonicalDirectoryPath, 'SKILL.md')
  for (const root of context.roots) {
    const depth = skillPathDepthBelow(root.path, canonicalSkillFile, context.semantics)
    if (depth === null || depth > skillFileMaxDepth(root.sourceKind)) {
      continue
    }
    if (root.sourceKind === 'plugin') {
      return 'plugin'
    }
    if (
      root.sourceKind === 'home' &&
      api.relative(root.path, canonicalSkillFile).split(context.semantics.sep)[0] === '.system'
    ) {
      return 'bundled'
    }
  }
  return null
}

export type ClassifiedPlacement = SkillDeletePlacement & { root: SkillScanRoot }

/**
 * Each kind compares against a different realpath. Comparing every entry's own
 * realpath against the file identity alone finds every `canonical` placement
 * and silently zero `alias-dir` ones — the exact shape this exists to remove.
 */
export function classifySkillPlacement(
  candidate: SkillPlacementCandidate,
  canonicalSkillFilePath: string,
  context: SkillDeleteGuardContext
): ClassifiedPlacement | null {
  const api = pathApi(context.semantics)
  const canonicalDirectoryPath = api.dirname(canonicalSkillFilePath)
  const owningRoot = owningSkillRoot(candidate.path, context)
  if (!owningRoot || skillPathsEqual(owningRoot.path, candidate.path, context.semantics)) {
    return null
  }
  const placement = (kind: SkillDeletePlacement['kind']): ClassifiedPlacement => ({
    path: candidate.path,
    kind,
    rootLabel: owningRoot.label,
    root: owningRoot
  })

  if (candidate.entryKind === 'symlink') {
    // A symlinked directory's realpath can never equal a file path, so this
    // compares against the canonical *directory*.
    return candidate.directoryRealpath &&
      skillPathsEqual(candidate.directoryRealpath, canonicalDirectoryPath, context.semantics)
      ? placement('alias-dir')
      : null
  }
  if (
    !candidate.skillFileRealpath ||
    !skillPathsEqual(candidate.skillFileRealpath, canonicalSkillFilePath, context.semantics)
  ) {
    return null
  }
  return placement(candidate.skillFileKind === 'symlink' ? 'alias-file' : 'canonical')
}
