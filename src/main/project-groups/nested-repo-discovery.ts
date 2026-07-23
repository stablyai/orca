/* eslint-disable max-lines -- Why: scanner traversal, ignore matching, and filesystem
abstraction stay together so local, SSH, and runtime scans cannot drift. */
import { opendir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  NestedRepoCandidate,
  NestedRepoScanOptions,
  NestedRepoScanResult
} from '../../shared/types'
import { isGitRepo } from '../git/repo'
import { NestedRepoScanBudget, type NestedRepoScanLimits } from './nested-repo-scan-budget'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'

type NestedRepoDirectoryEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

type NestedRepoScanFilesystem = {
  readDirectory: (
    dirPath: string
  ) =>
    | AsyncIterable<NestedRepoDirectoryEntry>
    | Iterable<NestedRepoDirectoryEntry>
    | Promise<AsyncIterable<NestedRepoDirectoryEntry> | Iterable<NestedRepoDirectoryEntry>>
  readTextFile?: (filePath: string) => Promise<string>
  joinPath: (parentPath: string, childName: string) => string
  basename: (path: string) => string
  hasGitMarker: (path: string) => Promise<boolean> | boolean
  isSelectedPathGitRepo: (path: string) => Promise<boolean> | boolean
}

type IgnoreRule = {
  pattern: string
  negate: boolean
  basenameOnly: boolean
  baseSegments: string[]
}

type TraversalFolder = {
  path: string
  depth: number
  segments: string[]
  ignoreRules: IgnoreRule[]
}

type NormalizedNestedRepoScanOptions = {
  maxDepth: number
  maxRepos: number
  timeoutMs: number | null
}

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_REPOS = 100
export const NESTED_REPO_GITIGNORE_MAX_BYTES = 1024 * 1024

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

function normalizeScanOptions(options: unknown): NormalizedNestedRepoScanOptions {
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

function globSegmentMatches(pattern: string, value: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return pattern === value
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
  return regex.test(value)
}

function pathSegmentsMatch(patternSegments: string[], candidateSegments: string[]): boolean {
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

function parseGitignoreRules(
  content: string,
  baseSegments: string[],
  budget: NestedRepoScanBudget
): IgnoreRule[] {
  const rules: IgnoreRule[] = []
  for (const match of content.matchAll(/[^\r\n]+/g)) {
    const line = match[0].trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const negate = line.startsWith('!')
    const unprefixed = negate ? line.slice(1) : line
    const anchored = unprefixed.startsWith('/')
    const pattern = unprefixed.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!pattern) {
      continue
    }
    if (!budget.tryRetainIgnoreRule(pattern)) {
      break
    }
    rules.push({
      pattern,
      negate,
      basenameOnly: !anchored && !pattern.includes('/'),
      baseSegments
    })
  }
  return rules
}

function isIgnoredByRules(name: string, segments: string[], rules: IgnoreRule[]): boolean {
  let ignored = false
  for (const rule of rules) {
    if (segments.length <= rule.baseSegments.length) {
      continue
    }
    const relativeSegments = segments.slice(rule.baseSegments.length)
    const patternSegments = rule.pattern.split('/')
    const matches = rule.basenameOnly
      ? relativeSegments.some((segment) => globSegmentMatches(rule.pattern, segment))
      : pathSegmentsMatch(patternSegments, relativeSegments)
    if (matches) {
      ignored = !rule.negate
    }
  }
  return ignored || shouldSkipDirectory(name, segments.length - 1)
}

async function readGitignoreRules(args: {
  folderPath: string
  entries: NestedRepoDirectoryEntry[]
  filesystem: NestedRepoScanFilesystem
  baseSegments: string[]
  budget: NestedRepoScanBudget
}): Promise<IgnoreRule[]> {
  if (!args.filesystem.readTextFile || !args.entries.some((entry) => entry.name === '.gitignore')) {
    return []
  }
  try {
    const content = await args.filesystem.readTextFile(
      args.filesystem.joinPath(args.folderPath, '.gitignore')
    )
    if (Buffer.byteLength(content, 'utf8') > NESTED_REPO_GITIGNORE_MAX_BYTES) {
      return []
    }
    return parseGitignoreRules(content, args.baseSegments, args.budget)
  } catch {
    return []
  }
}

async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const marker = await stat(join(dirPath, '.git'))
    if (marker.isDirectory() || marker.isFile()) {
      return true
    }
  } catch {
    // Continue to cheap bare-repository marker checks below.
  }
  const [head, objects, refs] = await Promise.all([
    stat(join(dirPath, 'HEAD')).catch(() => null),
    stat(join(dirPath, 'objects')).catch(() => null),
    stat(join(dirPath, 'refs')).catch(() => null)
  ])
  return head?.isFile() === true && objects?.isDirectory() === true && refs?.isDirectory() === true
}

async function* readLocalDirectory(dirPath: string): AsyncGenerator<NestedRepoDirectoryEntry> {
  const directory = await opendir(dirPath)
  for await (const entry of directory) {
    yield {
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink()
    }
  }
}

export async function scanNestedRepos(args: {
  path: string
  options?: unknown
  filesystem?: NestedRepoScanFilesystem
  signal?: AbortSignal
  onProgress?: (scan: NestedRepoScanResult) => void
  limits?: Partial<NestedRepoScanLimits>
}): Promise<NestedRepoScanResult> {
  const startedAt = Date.now()
  const options = normalizeScanOptions(args.options)
  const repos: NestedRepoCandidate[] = []
  let truncated = false
  let timedOut = false
  let stopped = false
  const scanBudget = new NestedRepoScanBudget(args.limits)
  const filesystem = args.filesystem ?? {
    readDirectory: readLocalDirectory,
    readTextFile: async (path: string) =>
      (await readNodeFileWithinLimit(path, NESTED_REPO_GITIGNORE_MAX_BYTES)).buffer.toString(
        'utf8'
      ),
    joinPath: join,
    basename,
    hasGitMarker,
    isSelectedPathGitRepo: async (path: string) => isGitRepo(path) || (await hasGitMarker(path))
  }
  const buildResult = (selectedPathKind: NestedRepoScanResult['selectedPathKind']) => ({
    selectedPath: args.path,
    selectedPathKind,
    repos: [...repos],
    truncated,
    timedOut,
    stopped,
    durationMs: Date.now() - startedAt,
    maxDepth: options.maxDepth,
    maxRepos: options.maxRepos,
    timeoutMs: options.timeoutMs
  })
  const noteAbort = (): boolean => {
    if (!args.signal?.aborted) {
      return false
    }
    stopped = true
    return true
  }
  const emitProgress = (): void => {
    args.onProgress?.(buildResult('non_git_folder'))
  }

  if (await filesystem.isSelectedPathGitRepo(args.path)) {
    return buildResult('git_repo')
  }
  if (noteAbort()) {
    return buildResult('non_git_folder')
  }

  const foldersToTraverse: TraversalFolder[] = [
    { path: args.path, depth: 0, segments: [], ignoreRules: [] }
  ]
  let nextFolderIndex = 0

  while (nextFolderIndex < foldersToTraverse.length) {
    if (repos.length >= options.maxRepos) {
      truncated = true
      break
    }
    if (options.timeoutMs !== null && Date.now() - startedAt > options.timeoutMs) {
      timedOut = true
      break
    }
    if (noteAbort()) {
      break
    }
    const currentFolder = foldersToTraverse[nextFolderIndex++]
    if (currentFolder.depth > options.maxDepth) {
      continue
    }

    let entries: NestedRepoDirectoryEntry[]
    try {
      entries = await collectNestedRepoDirectoryEntries(
        await filesystem.readDirectory(currentFolder.path),
        currentFolder.path,
        filesystem,
        scanBudget
      )
    } catch {
      continue
    }
    if (noteAbort()) {
      break
    }
    const currentIgnoreRules = [
      ...currentFolder.ignoreRules,
      ...(await readGitignoreRules({
        folderPath: currentFolder.path,
        entries,
        filesystem,
        baseSegments: currentFolder.segments,
        budget: scanBudget
      }))
    ]

    const dirs = entries
      .filter((entry) => entry.isDirectory && !entry.isSymlink)
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of dirs) {
      const name = entry.name
      if (repos.length >= options.maxRepos) {
        truncated = true
        break
      }
      if (options.timeoutMs !== null && Date.now() - startedAt > options.timeoutMs) {
        timedOut = true
        break
      }
      if (noteAbort()) {
        break
      }
      const childSegments = [...currentFolder.segments, name]
      if (isIgnoredByRules(name, childSegments, currentIgnoreRules)) {
        continue
      }
      const childPath = filesystem.joinPath(currentFolder.path, name)
      // Why: broad scans should use cheap filesystem markers instead of
      // spawning Git for every candidate directory, especially over SSH.
      const childHasGitMarker = await filesystem.hasGitMarker(childPath)
      if (noteAbort()) {
        break
      }
      if (childHasGitMarker) {
        repos.push({
          path: childPath,
          displayName: filesystem.basename(childPath),
          depth: currentFolder.depth + 1
        })
        emitProgress()
        // Project Groups organize sibling repos; nested repos stay hidden until a
        // later UI can explain and select submodule-style layouts explicitly.
        continue
      }
      // Why: group import should prefer nearby sibling repos over spending the
      // bounded scan inside an alphabetically early, deeply nested folder.
      if (currentFolder.depth < options.maxDepth) {
        foldersToTraverse.push({
          path: childPath,
          depth: currentFolder.depth + 1,
          segments: childSegments,
          ignoreRules: currentIgnoreRules
        })
      }
    }
    if (scanBudget.capacityReached) {
      truncated = true
      break
    }
  }

  return buildResult('non_git_folder')
}

async function collectNestedRepoDirectoryEntries(
  source: AsyncIterable<NestedRepoDirectoryEntry> | Iterable<NestedRepoDirectoryEntry>,
  directoryPath: string,
  filesystem: NestedRepoScanFilesystem,
  budget: NestedRepoScanBudget
): Promise<NestedRepoDirectoryEntry[]> {
  const entries: NestedRepoDirectoryEntry[] = []
  for await (const entry of source) {
    const entryPath = filesystem.joinPath(directoryPath, entry.name)
    if (!budget.tryVisitEntry(entryPath)) {
      break
    }
    entries.push(entry)
  }
  return entries
}
