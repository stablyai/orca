import { posix as pathPosix, win32 as pathWin32 } from 'node:path'
import type { Repo } from '../../../shared/repo-types'
import type {
  SkillDeleteBlockReason,
  SkillDeletePlan,
  SkillDeletePlanEntry,
  SkillDeleteRequest,
  SkillDeleteTargetSkill
} from '../../../shared/skill-delete-contract'
import {
  normalizedSkillPath,
  type SkillPathSemantics
} from '../../../shared/skill-path-containment'
import {
  enumerateSkillPlacementCandidates,
  requireEnumerableFilesystem,
  type SkillPlacementCandidate
} from './enumeration'
import {
  blockedCanonicalReason,
  classifySkillPlacement,
  isSkillDeleteFresh,
  owningSkillRoot,
  type ClassifiedPlacement,
  type SkillDeleteGuardContext
} from './guards'
import { buildSkillDeleteRootSet } from './roots'
import type { ResolvedSkillDiscoveryTarget } from '../skill-discovery-target'
import type { SkillInstallFilesystem } from '../skill-install-filesystem'
import type { SkillProviderRootOverrides } from '../skill-provider-destinations'
import type { SkillScanRoot } from '../skill-discovery-sources'

type IndexedSkillPlacement = { candidate: SkillPlacementCandidate; ordinal: number }

/** Deduplicate overlapping roots or the second stage rename fails and rolls the skill back. */
function dedupePlacements(
  placements: readonly ClassifiedPlacement[],
  semantics: SkillPathSemantics
): ClassifiedPlacement[] {
  const seen = new Set<string>()
  return placements.filter((placement) => {
    const key = normalizedSkillPath(placement.path, semantics)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function blockedEntry(
  skill: SkillDeleteTargetSkill,
  canonicalPath: string,
  blocked: SkillDeleteBlockReason
): SkillDeletePlanEntry {
  return { id: skill.id, name: skill.name, canonicalPath, placements: [], blocked }
}

export type SkillDeletePlanInput = {
  request: SkillDeleteRequest
  target: ResolvedSkillDiscoveryTarget
  repos: readonly Repo[]
  providerRootOverrides?: SkillProviderRootOverrides
  filesystem: SkillInstallFilesystem
  homeDir?: string
}

/** The plan plus what execution needs but the wire contract must not carry. */
export type ResolvedSkillDeletePlan = {
  plan: SkillDeletePlan
  semantics: SkillPathSemantics
  toFilesystemPath: (path: string) => string
  /** Root paths the filesystem must be authorized for before any operation. */
  rootPaths: string[]
  placementRoots: Map<string, ClassifiedPlacement[]>
}

/** Enumerate once per batch through the same path for preview/delete so promised removals match execution. */
export async function buildSkillDeletePlan(
  input: SkillDeletePlanInput
): Promise<ResolvedSkillDeletePlan> {
  const { roots, semantics, toFilesystemPath } = await buildSkillDeleteRootSet({
    target: input.target,
    repos: input.repos,
    ...(input.providerRootOverrides ? { providerRootOverrides: input.providerRootOverrides } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {})
  })
  const rootPaths = roots.map((root) => root.path)
  // Authorize all discovery roots before inspection; WSL install-provider roots are narrower. This independent containment check does not replace the shared path guard.
  input.filesystem.authorizeRoots?.(rootPaths.map(toFilesystemPath))

  const api = semantics.sep === '\\' ? pathWin32 : pathPosix
  // Compare canonical paths against realpath roots; literal roots misclassify symlinked homes and macOS /tmp as unowned.
  const context: SkillDeleteGuardContext = { semantics, roots }
  const canonicalContext: SkillDeleteGuardContext = {
    semantics,
    roots: await resolvedRoots(roots, input.filesystem, toFilesystemPath)
  }
  const requested = input.request.skills
  // Inspect only owned paths; asking the guest about outside paths would throw before returning unowned.
  const inspectable = requested.filter(
    (skill) => owningSkillRoot(api.dirname(skill.skillFilePath), context) !== null
  )
  const inspections = await inspectRequestedSkillFiles(
    inspectable,
    input.filesystem,
    toFilesystemPath
  )
  const candidates = await enumerateSkillPlacementCandidates({
    roots,
    filesystem: input.filesystem,
    semantics,
    toFilesystemPath
  })

  const candidatesByFile = new Map<string, IndexedSkillPlacement[]>()
  const candidatesByDirectory = new Map<string, IndexedSkillPlacement[]>()
  for (const [ordinal, candidate] of candidates.entries()) {
    const isDirectoryAlias = candidate.entryKind === 'symlink'
    const identity = isDirectoryAlias ? candidate.directoryRealpath : candidate.skillFileRealpath
    if (!identity) {
      continue
    }
    const index = isDirectoryAlias ? candidatesByDirectory : candidatesByFile
    const key = normalizedSkillPath(identity, semantics)
    const bucket = index.get(key) ?? []
    bucket.push({ candidate, ordinal })
    index.set(key, bucket)
  }

  const placementRoots = new Map<string, ClassifiedPlacement[]>()
  const skills = requested.map((skill): SkillDeletePlanEntry => {
    const inspection = inspections.get(skill.skillFilePath)
    if (!inspection) {
      return blockedEntry(skill, skill.skillFilePath, 'unowned')
    }
    const canonicalPath = inspection.realpath
    if (!canonicalPath || inspection.kind === 'missing') {
      return blockedEntry(skill, skill.skillFilePath, 'missing')
    }
    if (!isSkillDeleteFresh(skill.updatedAt, inspection.mtimeMs)) {
      return blockedEntry(skill, canonicalPath, 'stale')
    }
    const blocked = blockedCanonicalReason(api.dirname(canonicalPath), canonicalContext)
    if (blocked) {
      return blockedEntry(skill, canonicalPath, blocked)
    }
    const placements = dedupePlacements(
      [
        ...(candidatesByFile.get(normalizedSkillPath(canonicalPath, semantics)) ?? []),
        ...(candidatesByDirectory.get(normalizedSkillPath(api.dirname(canonicalPath), semantics)) ??
          [])
      ]
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(({ candidate }) => classifySkillPlacement(candidate, canonicalPath, context))
        .filter((placement): placement is ClassifiedPlacement => placement !== null),
      semantics
    )
    if (placements.length === 0) {
      return blockedEntry(skill, canonicalPath, 'unowned')
    }
    placementRoots.set(skill.id, placements)
    return {
      id: skill.id,
      name: skill.name,
      canonicalPath,
      placements: placements.map(({ path, kind, rootLabel }) => ({ path, kind, rootLabel }))
    }
  })

  return {
    plan: { operationId: input.request.operationId, skills },
    semantics,
    toFilesystemPath,
    rootPaths,
    placementRoots
  }
}

async function resolvedRoots(
  roots: readonly SkillScanRoot[],
  filesystem: SkillInstallFilesystem,
  toFilesystemPath: (path: string) => string
): Promise<SkillScanRoot[]> {
  const inspections = await filesystem
    .inspectPaths?.(roots.map((root) => toFilesystemPath(root.path)))
    .catch(() => null)
  return roots.map((root) => {
    const realpath = inspections?.get(toFilesystemPath(root.path))?.realpath
    return realpath
      ? { ...root, path: fromFilesystemPath(realpath, root.path, toFilesystemPath) }
      : root
  })
}

/** Guest realpaths use host-owned spelling; fall back to literal roots if conversion diverges. */
function fromFilesystemPath(
  realpath: string,
  literalRoot: string,
  toFilesystemPath: (path: string) => string
): string {
  return toFilesystemPath(realpath) === realpath || toFilesystemPath(literalRoot) !== literalRoot
    ? realpath
    : literalRoot
}

async function inspectRequestedSkillFiles(
  skills: readonly SkillDeleteTargetSkill[],
  filesystem: SkillInstallFilesystem,
  toFilesystemPath: (path: string) => string
): ReturnType<NonNullable<SkillInstallFilesystem['inspectPaths']>> {
  const { inspectPaths } = requireEnumerableFilesystem(filesystem)
  const paths = [...new Set(skills.map((skill) => skill.skillFilePath))]
  const raw = await inspectPaths(paths.map(toFilesystemPath))
  return new Map(
    paths.flatMap((path) => {
      const inspection = raw.get(toFilesystemPath(path))
      return inspection ? [[path, inspection] as const] : []
    })
  )
}
