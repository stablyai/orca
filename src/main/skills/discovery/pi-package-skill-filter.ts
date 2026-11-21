import { basename, dirname, relative, resolve } from 'node:path'
import {
  hasNestedPiExclusion,
  inspectPiSkillDir,
  isPathWithinPackageRoot,
  matchesPiSkillPattern,
  normalizePiSkillPattern,
  piSkillGlobToRegExp
} from './pi-package-source-path'

async function collectDirsToDepth(
  dirPath: string,
  maxDepth: number,
  signal?: AbortSignal
): Promise<string[]> {
  if (maxDepth <= 0) {
    return []
  }
  const { childDirs } = await inspectPiSkillDir(dirPath, signal)
  if (maxDepth === 1 || childDirs.length === 0) {
    return childDirs
  }
  const nested = await Promise.all(
    childDirs.map((child) => collectDirsToDepth(child, maxDepth - 1, signal))
  )
  return [...childDirs, ...nested.flat()]
}

const MAX_FINITE_GLOB_SEGMENTS = 16

async function collectMatchingSegments(
  dirPath: string,
  segments: readonly string[],
  signal?: AbortSignal
): Promise<string[]> {
  if (segments.length === 0) {
    return [dirPath]
  }
  const [head, ...tail] = segments
  const headRegex = piSkillGlobToRegExp(head)
  const { childDirs } = await inspectPiSkillDir(dirPath, signal)
  const matching = childDirs.filter((child) => headRegex.test(basename(child)))
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
  const regex = piSkillGlobToRegExp(normalized)
  const candidates = await collectDirsToDepth(searchBase, 4, signal)
  return candidates.filter((child) => {
    const rel = relative(packageRoot, child).replace(/\\/g, '/')
    return regex.test(rel)
  })
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
  const result: string[] = []
  for (const root of roots) {
    const rel = relative(packageRoot, root).replace(/\\/g, '/')
    if (matchesPiSkillPattern(rel, exclusions)) {
      continue
    }
    const hasNestedExclusion = depth < 4 && exclusions.some((ex) => hasNestedPiExclusion(rel, ex))
    if (hasNestedExclusion) {
      const { hasSkillFile, childDirs } = await inspectPiSkillDir(root, signal)
      if (!hasSkillFile && childDirs.length > 0) {
        result.push(
          ...(await applyExclusions(packageRoot, childDirs, exclusions, signal, depth + 1))
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

  const expandWithinManifest = async (patterns: readonly string[]): Promise<string[]> =>
    (await Promise.all(patterns.map((p) => expandPositivePattern(packageRoot, p, signal))))
      .flat()
      .filter((candidate) => manifestRoots.some((base) => isPathWithinPackageRoot(base, candidate)))

  const candidates = positive.length > 0 ? await expandWithinManifest(positive) : [...manifestRoots]
  const filtered = await applyExclusions(packageRoot, candidates, exclusions, signal)
  if (forceIncludes.length > 0) {
    filtered.push(...(await expandWithinManifest(forceIncludes)))
  }
  return Array.from(
    new Set(
      forceExcludes.length > 0
        ? await applyExclusions(packageRoot, filtered, forceExcludes, signal)
        : filtered
    )
  )
}
