/* eslint-disable max-lines -- Why: scanner traversal, ignore matching, and filesystem
abstraction stay together so local, SSH, and runtime scans cannot drift. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  NestedRepoCandidate,
  NestedRepoScanOptions,
  NestedRepoScanResult
} from '../../shared/project-group-types'
import { isAgentScratchRepoRootPath } from '../../shared/agent-scratch-worktrees'
import { hasImportableNestedRepo } from '../../shared/nested-repo-candidates'
import { isGitRepo } from '../git/repo'

type NestedRepoDirectoryEntry = {
  name: string
  isDirectory: boolean
  isSymlink?: boolean
}

type NestedRepoScanFilesystem = {
  readDirectory: (dirPath: string) => Promise<NestedRepoDirectoryEntry[]>
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

// A .gitmodules entry, resolved against the repo root that declared it.
type SubmoduleRule = {
  segments: string[]
  baseSegments: string[]
}

type TraversalFolder = {
  path: string
  depth: number
  segments: string[]
  ignoreRules: IgnoreRule[]
  submoduleRules: SubmoduleRule[]
}

type NormalizedNestedRepoScanOptions = {
  maxDepth: number
  maxRepos: number
  timeoutMs: number | null
  includeReposInsideGitRepos: boolean
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

// Why: repos-inside-repos drops gitignore pruning and the local add path sends no
// timeout, so without a wall clock of its own that scan is unbounded.
const REPOS_INSIDE_REPOS_TIMEOUT_MS = 10_000

function normalizeScanOptions(options: unknown): NormalizedNestedRepoScanOptions {
  const raw = options && typeof options === 'object' ? (options as NestedRepoScanOptions) : {}
  if (raw.includeReposInsideGitRepos === true && raw.timeoutMs === undefined) {
    return normalizeScanOptions({ ...raw, timeoutMs: REPOS_INSIDE_REPOS_TIMEOUT_MS })
  }
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
          : null,
    includeReposInsideGitRepos: raw.includeReposInsideGitRepos === true
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
      return {
        pattern,
        negate,
        basenameOnly: !anchored && !pattern.includes('/'),
        baseSegments
      }
    })
    .filter((rule) => rule.pattern.length > 0)
}

function matchesIgnoreRules(segments: string[], rules: IgnoreRule[]): boolean {
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
  return ignored
}

const GITMODULES_SECTION_PATTERN = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/
const GITMODULES_PATH_PATTERN = /^\s*path\s*=\s*(.+?)\s*$/

function parseGitmodulesRules(content: string, baseSegments: string[]): SubmoduleRule[] {
  const rules: SubmoduleRule[] = []
  // Why scoped: `path` only declares a submodule under [submodule "…"]; accepted
  // anywhere, a hand-edited [core] path drops an independent repo from the import.
  let inSubmoduleSection = false
  for (const rawLine of content.split(/\r?\n/)) {
    if (/^\s*[#;]/.test(rawLine)) {
      continue
    }
    const section = GITMODULES_SECTION_PATTERN.exec(rawLine)
    if (section) {
      // Section names are case-insensitive in git config.
      inSubmoduleSection = section[1].toLowerCase() === 'submodule'
    }
    if (!inSubmoduleSection) {
      continue
    }
    // Git config allows the variable on the header's own line, so parse past it.
    const value = GITMODULES_PATH_PATTERN.exec(
      section ? rawLine.slice(section[0].length) : rawLine
    )?.[1]
    if (value === undefined) {
      continue
    }
    const segments = value.replace(/\\/g, '/').split('/').filter(Boolean)
    if (segments.length > 0) {
      rules.push({ segments, baseSegments })
    }
  }
  return rules
}

function isSubmodulePath(segments: string[], rules: SubmoduleRule[]): boolean {
  return rules.some(
    (rule) =>
      segments.length === rule.baseSegments.length + rule.segments.length &&
      rule.segments.every(
        (segment, index) => segment === segments[rule.baseSegments.length + index]
      )
  )
}

async function readGitmodulesRules(args: {
  folderPath: string
  entries: NestedRepoDirectoryEntry[]
  filesystem: NestedRepoScanFilesystem
  baseSegments: string[]
}): Promise<SubmoduleRule[]> {
  if (
    !args.filesystem.readTextFile ||
    !args.entries.some((entry) => entry.name === '.gitmodules')
  ) {
    return []
  }
  try {
    return parseGitmodulesRules(
      await args.filesystem.readTextFile(args.filesystem.joinPath(args.folderPath, '.gitmodules')),
      args.baseSegments
    )
  } catch {
    return []
  }
}

async function readGitignoreRules(args: {
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

async function readLocalDirectory(dirPath: string): Promise<NestedRepoDirectoryEntry[]> {
  // Why: Dirent data avoids one stat per child and keeps symlinked directories
  // from expanding the scan outside the selected folder.
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.map((entry) => ({
    name: entry.name,
    isDirectory: entry.isDirectory(),
    isSymlink: entry.isSymbolicLink()
  }))
}

export async function scanNestedRepos(args: {
  path: string
  options?: unknown
  filesystem?: NestedRepoScanFilesystem
  signal?: AbortSignal
  onProgress?: (scan: NestedRepoScanResult) => void
}): Promise<NestedRepoScanResult> {
  const startedAt = Date.now()
  const options = normalizeScanOptions(args.options)
  const repos: NestedRepoCandidate[] = []
  let truncated = false
  let timedOut = false
  let stopped = false
  const filesystem = args.filesystem ?? {
    readDirectory: readLocalDirectory,
    readTextFile: (path: string) => readFile(path, 'utf8'),
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
  const selectedPathIsGitRepo = await filesystem.isSelectedPathGitRepo(args.path)
  const selectedPathKind: NestedRepoScanResult['selectedPathKind'] = selectedPathIsGitRepo
    ? 'git_repo'
    : 'non_git_folder'
  // Why: the picked repo is not a discovery, so it never spends the maxRepos
  // budget and joins only once a nested repo turns up — otherwise the plain
  // "add this repo" path would open a review with nothing to review.
  const withSelectedRepoCandidate = (): NestedRepoScanResult => {
    const result = buildResult(selectedPathKind)
    // Why importable and not merely present: a repo whose only nested repos are
    // its own submodules is a plain repo, and must not be turned into a review.
    if (!selectedPathIsGitRepo || !hasImportableNestedRepo(result.repos)) {
      return result
    }
    return {
      ...result,
      repos: [
        { path: args.path, displayName: filesystem.basename(args.path), depth: 0 },
        ...result.repos
      ]
    }
  }
  const emitProgress = (): void => {
    args.onProgress?.(withSelectedRepoCandidate())
  }

  if (selectedPathIsGitRepo && !options.includeReposInsideGitRepos) {
    return buildResult('git_repo')
  }
  if (noteAbort()) {
    return withSelectedRepoCandidate()
  }

  const foldersToTraverse: TraversalFolder[] = [
    { path: args.path, depth: 0, segments: [], ignoreRules: [], submoduleRules: [] }
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
      entries = await filesystem.readDirectory(currentFolder.path)
    } catch {
      continue
    }
    if (noteAbort()) {
      break
    }
    // Why: a parent gitignores exactly the independent clones it holds, so here the
    // ignore file hides the repos being looked for. The other bounds cap the cost.
    const currentIgnoreRules = options.includeReposInsideGitRepos
      ? []
      : [
          ...currentFolder.ignoreRules,
          ...(await readGitignoreRules({
            folderPath: currentFolder.path,
            entries,
            filesystem,
            baseSegments: currentFolder.segments
          }))
        ]
    const currentSubmoduleRules = [
      ...currentFolder.submoduleRules,
      ...(await readGitmodulesRules({
        folderPath: currentFolder.path,
        entries,
        filesystem,
        baseSegments: currentFolder.segments
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
      if (shouldSkipDirectory(name, childSegments.length - 1)) {
        continue
      }
      if (matchesIgnoreRules(childSegments, currentIgnoreRules)) {
        continue
      }
      const childPath = filesystem.joinPath(currentFolder.path, name)
      // Why: broad scans should use cheap filesystem markers instead of
      // spawning Git for every candidate directory, especially over SSH.
      const childHasGitMarker = await filesystem.hasGitMarker(childPath)
      if (noteAbort()) {
        break
      }
      // Why excluded rather than listed: a repo minted by an agent CLI under one
      // of these roots is agent-internal, not a user project (#9388).
      if (childHasGitMarker && isAgentScratchRepoRootPath(childPath)) {
        continue
      }
      if (childHasGitMarker) {
        repos.push({
          path: childPath,
          displayName: filesystem.basename(childPath),
          depth: currentFolder.depth + 1,
          // Spread so a plain repo's candidate shape stays untouched.
          ...(isSubmodulePath(childSegments, currentSubmoduleRules) ? { isSubmodule: true } : {})
        })
        emitProgress()
        // Project Groups organize sibling repos, so a discovered repo ends the
        // branch unless the caller asked for repos inside repos.
        if (!options.includeReposInsideGitRepos) {
          continue
        }
      }
      // Why: group import should prefer nearby sibling repos over spending the
      // bounded scan inside an alphabetically early, deeply nested folder.
      if (currentFolder.depth < options.maxDepth) {
        foldersToTraverse.push({
          path: childPath,
          depth: currentFolder.depth + 1,
          segments: childSegments,
          ignoreRules: currentIgnoreRules,
          submoduleRules: currentSubmoduleRules
        })
      }
    }
  }

  return withSelectedRepoCandidate()
}
