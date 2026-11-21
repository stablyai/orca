import { basename, dirname, relative, resolve } from 'node:path'
import {
  hasNestedPiExclusion,
  matchesPiSkillGlob,
  matchesPiSkillPattern,
  normalizePiSkillPattern
} from './pi-package-skill-glob'
import { inspectPiSkillDir, isPathWithinPackageRoot } from './pi-package-source-path'

const SKIPPED_GLOB_DIRS = new Set(['.git', 'node_modules'])

async function collectDirsToDepth(
  dirPath: string,
  maxDepth: number,
  signal?: AbortSignal
): Promise<string[]> {
  if (maxDepth <= 0) {
    return []
  }
  const { childDirs } = await inspectPiSkillDir(dirPath, signal)
  const visibleDirs = childDirs.filter((child) => !SKIPPED_GLOB_DIRS.has(basename(child)))
  if (maxDepth === 1 || visibleDirs.length === 0) {
    return visibleDirs
  }
  const nested = await Promise.all(
    visibleDirs.map((child) => collectDirsToDepth(child, maxDepth - 1, signal))
  )
  return [...visibleDirs, ...nested.flat()]
}

const MAX_FINITE_GLOB_SEGMENTS = 16
const hasGlobMeta = (pattern: string): boolean => /[*?[\]]/.test(pattern)

async function collectMatchingSegments(
  dirPath: string,
  segments: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  if (segments.length === 0) {
    return [dirPath]
  }
  const [head, ...tail] = segments
  const { childDirs } = await inspectPiSkillDir(dirPath, signal)
  const candidates = hasGlobMeta(head)
    ? childDirs.filter((child) => !SKIPPED_GLOB_DIRS.has(basename(child)))
    : childDirs
  const matching = candidates.filter((child) => matchesPiSkillGlob(head, basename(child)))
  if (tail.length === 0 || matching.length === 0) {
    return matching
  }
  const nested = await Promise.all(
    matching.map((child) => collectMatchingSegments(child, tail, signal))
  )
  return nested.flat()
}

async function expandPositivePattern(
  packageRoot: string,
  pattern: string,
  signal?: AbortSignal
): Promise<string[]> {
  const clean = normalizePiSkillPattern(pattern)
  if (!clean) {
    return []
  }
  if (!/[*?[\]]/.test(clean)) {
    const resolved = resolve(packageRoot, clean)
    if (!isPathWithinPackageRoot(packageRoot, resolved)) {
      return []
    }
    return [basename(resolved).toLowerCase() === 'skill.md' ? dirname(resolved) : resolved]
  }
  const normalized = clean.replace(/\/SKILL\.md$/i, '')
  const metaIndex = normalized.search(/[*?[\]]/)
  const beforeMeta = metaIndex !== -1 ? normalized.slice(0, metaIndex) : normalized
  const lastSlash = beforeMeta.lastIndexOf('/')
  const staticPrefix = lastSlash !== -1 ? beforeMeta.slice(0, lastSlash) : ''
  const searchBase = staticPrefix ? resolve(packageRoot, staticPrefix) : packageRoot
  if (!isPathWithinPackageRoot(packageRoot, searchBase)) {
    return []
  }
  const remaining = staticPrefix ? normalized.slice(staticPrefix.length + 1) : normalized
  if (!normalized.includes('**')) {
    const segments = remaining.split('/').filter(Boolean)
    if (segments.length === 0 || segments.length > MAX_FINITE_GLOB_SEGMENTS) {
      return []
    }
    return collectMatchingSegments(searchBase, segments, signal)
  }
  const candidates = [searchBase, ...(await collectDirsToDepth(searchBase, 4, signal))]
  const matched = candidates.filter((child) => {
    const rel = relative(packageRoot, child).replace(/\\/g, '/')
    return matchesPiSkillGlob(normalized, rel)
  })
  return matched.filter(
    (candidate) =>
      !matched.some((other) => other !== candidate && isPathWithinPackageRoot(other, candidate))
  )
}

function isBasenamePattern(pattern: string): boolean {
  const clean = normalizePiSkillPattern(pattern)
  return Boolean(clean) && !clean.includes('/') && clean !== '.' && clean !== '**'
}

async function collectSkillDirs(root: string, signal?: AbortSignal, depth = 0): Promise<string[]> {
  const { hasSkillFile, childDirs } = await inspectPiSkillDir(root, signal)
  if (hasSkillFile) {
    return [root]
  }
  if (depth >= 4) {
    return []
  }
  const visibleDirs = childDirs.filter((child) => !SKIPPED_GLOB_DIRS.has(basename(child)))
  if (visibleDirs.length === 0) {
    return []
  }
  const nested = await Promise.all(
    visibleDirs.map((child) => collectSkillDirs(child, signal, depth + 1))
  )
  return nested.flat()
}

async function applyExclusions(
  packageRoot: string,
  roots: readonly string[],
  exclusions: readonly string[],
  signal?: AbortSignal,
  depth = 0
): Promise<string[]> {
  if (exclusions.length === 0) {
    return [...roots]
  }
  const basenameExclusions = exclusions.filter(isBasenamePattern)
  const result: string[] = []
  for (const root of roots) {
    const rel = relative(packageRoot, root).replace(/\\/g, '/')
    if (matchesPiSkillPattern(rel, exclusions)) {
      continue
    }
    const matchesBasename = basenameExclusions.some((ex) => matchesPiSkillGlob(ex, basename(root)))
    const hasNestedExclusion =
      depth < 4 &&
      (basenameExclusions.length > 0 || exclusions.some((ex) => hasNestedPiExclusion(rel, ex)))
    if (matchesBasename || hasNestedExclusion) {
      const { hasSkillFile, childDirs } = await inspectPiSkillDir(root, signal)
      if (hasSkillFile && matchesBasename) {
        continue
      }
      if (hasNestedExclusion && !hasSkillFile && childDirs.length > 0) {
        const visibleDirs = childDirs.filter((child) => !SKIPPED_GLOB_DIRS.has(basename(child)))
        result.push(
          ...(await applyExclusions(packageRoot, visibleDirs, exclusions, signal, depth + 1))
        )
        continue
      }
    }
    result.push(root)
  }
  return result
}

export async function resolveDeclaredPiSkillEntries(
  packageRoot: string,
  entries: readonly unknown[],
  signal?: AbortSignal
): Promise<string[]> {
  const positive: string[] = []
  const exclusions: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      continue
    }
    const trimmed = entry.trim()
    if (!trimmed) {
      continue
    }
    if (trimmed.startsWith('!')) {
      const target = trimmed.slice(1).trim()
      if (target) {
        exclusions.push(target)
      }
    } else {
      positive.push(trimmed)
    }
  }
  const expanded = (
    await Promise.all(positive.map((p) => expandPositivePattern(packageRoot, p, signal)))
  ).flat()
  return Array.from(new Set(await applyExclusions(packageRoot, expanded, exclusions, signal)))
}

export async function filterPiManifestRoots(
  packageRoot: string,
  manifestRoots: readonly string[],
  skillsFilter: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  const positive: string[] = []
  const forceIncludes: string[] = []
  const exclusions: string[] = []
  const forceExcludes: string[] = []
  for (const raw of skillsFilter) {
    const trimmed = raw.trim()
    if (!trimmed) {
      continue
    }
    if (trimmed.startsWith('!') || trimmed.startsWith('-')) {
      const target = trimmed.slice(1).trim()
      if (target) {
        ;(trimmed.startsWith('-') ? forceExcludes : exclusions).push(target)
      }
    } else if (trimmed.startsWith('+')) {
      const target = trimmed.slice(1).trim()
      if (target) {
        forceIncludes.push(target)
      }
    } else {
      positive.push(trimmed)
    }
  }

  let cachedSkillDirs: string[] | null = null
  const getManifestSkillDirs = async (): Promise<string[]> => {
    if (cachedSkillDirs === null) {
      cachedSkillDirs = (
        await Promise.all(manifestRoots.map((root) => collectSkillDirs(root, signal)))
      ).flat()
    }
    return cachedSkillDirs
  }

  const expandWithinManifest = async (patterns: readonly string[]): Promise<string[]> => {
    const pathMatches = (
      await Promise.all(patterns.map((p) => expandPositivePattern(packageRoot, p, signal)))
    )
      .flat()
      .flatMap((candidate) =>
        manifestRoots.some((base) => isPathWithinPackageRoot(base, candidate))
          ? [candidate]
          : manifestRoots.filter((base) => isPathWithinPackageRoot(candidate, base))
      )
    const basenamePatterns = patterns.filter(isBasenamePattern)
    if (basenamePatterns.length === 0) {
      return pathMatches
    }
    const skillDirs = await getManifestSkillDirs()
    const basenameMatches = skillDirs.filter((dir) =>
      basenamePatterns.some((pattern) => matchesPiSkillGlob(pattern, basename(dir)))
    )
    return [...pathMatches, ...basenameMatches]
  }

  const candidates = positive.length > 0 ? await expandWithinManifest(positive) : [...manifestRoots]
  const filtered = await applyExclusions(packageRoot, candidates, exclusions, signal)
  const exactForceIncludes = forceIncludes.filter((p) => !hasGlobMeta(p))
  if (exactForceIncludes.length > 0) {
    filtered.push(...(await expandWithinManifest(exactForceIncludes)))
  }
  const exactForceExcludes = forceExcludes.filter((p) => !hasGlobMeta(p))
  return Array.from(
    new Set(
      exactForceExcludes.length > 0
        ? await applyExclusions(packageRoot, filtered, exactForceExcludes, signal)
        : filtered
    )
  )
}
