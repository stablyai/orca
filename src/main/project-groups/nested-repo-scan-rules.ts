import type { NestedRepoScanOptions } from '../../shared/project-group-types'

export type NestedRepoDirectoryEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

export type NestedRepoScanFilesystem = {
  readDirectory: (dirPath: string) => Promise<NestedRepoDirectoryEntry[]>
  readTextFile?: (filePath: string) => Promise<string>
  joinPath: (parentPath: string, childName: string) => string
  basename: (path: string) => string
  hasGitMarker: (path: string) => Promise<boolean> | boolean
  isSelectedPathGitRepo: (path: string) => Promise<boolean> | boolean
}

type IgnoreRule = {
  pattern: string
  segmentPatterns: GlobSegment[]
  negate: boolean
  basenameOnly: boolean
  baseSegments: string[]
}

type GlobSegment = string | { pattern: string }

export type TraversalFolder = {
  path: string
  depth: number
  segments: string[]
  ignoreRules: IgnoreRule[]
}

export type NormalizedNestedRepoScanOptions = {
  maxDepth: number
  maxRepos: number
  timeoutMs: number | null
}

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_REPOS = 100

const SKIPPED_DIRS = new Set([
  'node_modules',
  '.next',
  'dist',
  'build',
  '.cache',
  'vendor',
  '__pycache__',
  '.turbo',
  '.parcel-cache'
])

const VCS_METADATA_DIRS = new Set(['.git', '.svn', '.hg', '.jj', '.sl', '.repo', 'CVS'])

export function normalizeNestedRepoScanOptions(options: unknown): NormalizedNestedRepoScanOptions {
  const raw = options && typeof options === 'object' ? (options as NestedRepoScanOptions) : {}
  return {
    maxDepth:
      typeof raw.maxDepth === 'number' && Number.isFinite(raw.maxDepth)
        ? Math.max(1, Math.min(8, Math.floor(raw.maxDepth)))
        : DEFAULT_MAX_DEPTH,
    maxRepos:
      typeof raw.maxRepos === 'number' && Number.isFinite(raw.maxRepos)
        ? Math.max(1, Math.min(500, Math.floor(raw.maxRepos)))
        : DEFAULT_MAX_REPOS,
    timeoutMs:
      raw.timeoutMs === null
        ? null
        : typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
          ? Math.max(500, Math.min(30_000, Math.floor(raw.timeoutMs)))
          : null
  }
}

function shouldSkipDirectory(name: string, depth: number): boolean {
  if (VCS_METADATA_DIRS.has(name)) {
    return true
  }
  if (SKIPPED_DIRS.has(name)) {
    return true
  }
  return depth > 0 && name.startsWith('.')
}

function compileGlobSegment(pattern: string): GlobSegment {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern
  }
  return { pattern }
}

function globSegmentMatches(segment: GlobSegment, value: string): boolean {
  if (typeof segment === 'string') {
    return segment === value
  }
  const { pattern } = segment
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let starMatchIndex = 0
  // Retry only the latest star, avoiding combinatorial regular-expression backtracking.
  while (valueIndex < value.length) {
    const token = pattern[patternIndex]
    if (token === '*') {
      starIndex = patternIndex++
      starMatchIndex = valueIndex
    } else if (token === value[valueIndex] || (token === '?' && value[valueIndex] !== '/')) {
      patternIndex++
      valueIndex++
    } else if (starIndex !== -1 && value[starMatchIndex] !== '/') {
      patternIndex = starIndex + 1
      valueIndex = ++starMatchIndex
    } else {
      return false
    }
  }
  while (pattern[patternIndex] === '*') {
    patternIndex++
  }
  return patternIndex === pattern.length
}

function pathSegmentsMatch(patternSegments: GlobSegment[], candidateSegments: string[]): boolean {
  const matchFrom = (patternIndex: number, candidateIndex: number): boolean => {
    if (patternIndex >= patternSegments.length) {
      return candidateIndex >= candidateSegments.length
    }
    const pattern = patternSegments[patternIndex]
    if (pattern === '**') {
      return (
        matchFrom(patternIndex + 1, candidateIndex) ||
        (candidateIndex < candidateSegments.length && matchFrom(patternIndex, candidateIndex + 1))
      )
    }
    return (
      candidateIndex < candidateSegments.length &&
      globSegmentMatches(pattern, candidateSegments[candidateIndex] ?? '') &&
      matchFrom(patternIndex + 1, candidateIndex + 1)
    )
  }
  return matchFrom(0, 0)
}

function parseGitignoreRules(content: string, baseSegments: string[]): IgnoreRule[] {
  return content
    .split(/\r?\n/)
    .map((rawLine) => rawLine.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const negate = line.startsWith('!')
      const unprefixed = negate ? line.slice(1) : line
      const anchored = unprefixed.startsWith('/')
      const pattern = unprefixed.replace(/^\/+/, '').replace(/\/+$/, '')
      const basenameOnly = !anchored && !pattern.includes('/')
      return {
        pattern,
        segmentPatterns: basenameOnly
          ? [compileGlobSegment(pattern)]
          : pattern
              .split('/')
              .map((segment) => (segment === '**' ? segment : compileGlobSegment(segment))),
        negate,
        basenameOnly,
        baseSegments
      }
    })
    .filter((rule) => rule.pattern.length > 0)
}

export function isIgnoredNestedRepoDirectory(
  name: string,
  segments: string[],
  rules: IgnoreRule[]
): boolean {
  let ignored = false
  for (const rule of rules) {
    if (segments.length <= rule.baseSegments.length) {
      continue
    }
    const relativeSegments = segments.slice(rule.baseSegments.length)
    const matches = rule.basenameOnly
      ? relativeSegments.some((segment) => globSegmentMatches(rule.segmentPatterns[0], segment))
      : pathSegmentsMatch(rule.segmentPatterns, relativeSegments)
    if (matches) {
      ignored = !rule.negate
    }
  }
  return ignored || shouldSkipDirectory(name, segments.length - 1)
}

export async function readNestedRepoGitignoreRules(args: {
  folderPath: string
  entries: NestedRepoDirectoryEntry[]
  filesystem: NestedRepoScanFilesystem
  baseSegments: string[]
}): Promise<IgnoreRule[]> {
  if (!args.filesystem.readTextFile || !args.entries.some((entry) => entry.name === '.gitignore')) {
    return []
  }
  try {
    const content = await args.filesystem.readTextFile(
      args.filesystem.joinPath(args.folderPath, '.gitignore')
    )
    return parseGitignoreRules(content, args.baseSegments)
  } catch {
    return []
  }
}
