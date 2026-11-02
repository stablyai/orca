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

/** Allow clock/read skew; WSL discovery and recheck use the same host stat precision. */
export const SKILL_DELETE_FRESHNESS_TOLERANCE_MS = 1_000

export type SkillDeleteGuardContext = {
  semantics: SkillPathSemantics
  roots: readonly SkillScanRoot[]
}

function pathApi(semantics: SkillPathSemantics): typeof pathPosix {
  return semantics.sep === '\\' ? pathWin32 : pathPosix
}

/** Missing mtime is unknown, never unchanged; fail closed on delete freshness. */
export function isSkillDeleteFresh(
  displayedUpdatedAt: number | null,
  observedMtimeMs: number | null
): boolean {
  if (displayedUpdatedAt === null || observedMtimeMs === null) {
    return false
  }
  return Math.abs(displayedUpdatedAt - observedMtimeMs) <= SKILL_DELETE_FRESHNESS_TOLERANCE_MS
}

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

/** Re-derive canonical eligibility on the host: symlinked plugin/.system skills may report home on clients. External content stays untouched, but its owned in-root links may be deleted; no owned placements means unowned. */
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

/** Canonical and alias-file placements match file identity; directory aliases must match directory realpath. */
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
