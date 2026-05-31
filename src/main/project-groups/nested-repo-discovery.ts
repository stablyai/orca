import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import type {
  NestedRepoCandidate,
  NestedRepoScanOptions,
  NestedRepoScanResult
} from '../../shared/types'
import { isGitRepo } from '../git/repo'

type NestedRepoDirectoryEntry = {
  name: string
  isDirectory: boolean
}

type NestedRepoScanFilesystem = {
  readDirectory: (dirPath: string) => Promise<NestedRepoDirectoryEntry[]>
  joinPath: (parentPath: string, childName: string) => string
  basename: (path: string) => string
  isGitRepoPath: (path: string) => Promise<boolean> | boolean
}

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_MAX_REPOS = 100
const DEFAULT_TIMEOUT_MS = 8_000

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

function normalizeScanOptions(options: unknown): Required<NestedRepoScanOptions> {
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
      typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
        ? Math.max(500, Math.min(30_000, Math.floor(raw.timeoutMs)))
        : DEFAULT_TIMEOUT_MS
  }
}

function shouldSkipDirectory(name: string, depth: number): boolean {
  if (SKIPPED_DIRS.has(name)) {
    return true
  }
  return depth > 0 && name.startsWith('.')
}

async function hasGitMarker(dirPath: string): Promise<boolean> {
  try {
    const marker = await stat(join(dirPath, '.git'))
    return marker.isDirectory() || marker.isFile()
  } catch {
    return false
  }
}

async function readLocalDirectory(dirPath: string): Promise<NestedRepoDirectoryEntry[]> {
  // Why: Dirent data avoids one stat per child and keeps symlinked directories
  // from expanding the scan outside the selected folder.
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
}

export async function scanNestedRepos(args: {
  path: string
  options?: unknown
  filesystem?: NestedRepoScanFilesystem
}): Promise<NestedRepoScanResult> {
  const startedAt = Date.now()
  const options = normalizeScanOptions(args.options)
  const repos: NestedRepoCandidate[] = []
  let truncated = false
  let timedOut = false
  const filesystem = args.filesystem ?? {
    readDirectory: readLocalDirectory,
    joinPath: join,
    basename,
    isGitRepoPath: async (path: string) => isGitRepo(path) || (await hasGitMarker(path))
  }

  if (await filesystem.isGitRepoPath(args.path)) {
    return {
      selectedPath: args.path,
      selectedPathKind: 'git_repo',
      repos: [],
      truncated: false,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      maxDepth: options.maxDepth
    }
  }

  const visit = async (dirPath: string, depth: number): Promise<void> => {
    if (repos.length >= options.maxRepos) {
      truncated = true
      return
    }
    if (Date.now() - startedAt > options.timeoutMs) {
      timedOut = true
      return
    }
    if (depth > options.maxDepth) {
      return
    }

    let entries: NestedRepoDirectoryEntry[]
    try {
      entries = await filesystem.readDirectory(dirPath)
    } catch {
      return
    }

    const dirs = entries
      .filter((entry) => entry.isDirectory)
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of dirs) {
      const name = entry.name
      if (repos.length >= options.maxRepos) {
        truncated = true
        return
      }
      if (Date.now() - startedAt > options.timeoutMs) {
        timedOut = true
        return
      }
      if (shouldSkipDirectory(name, depth)) {
        continue
      }
      const childPath = filesystem.joinPath(dirPath, name)
      if (await filesystem.isGitRepoPath(childPath)) {
        repos.push({
          path: childPath,
          displayName: filesystem.basename(childPath),
          depth: depth + 1
        })
        // Project Groups organize sibling repos; nested repos stay hidden until a
        // later UI can explain and select submodule-style layouts explicitly.
        continue
      }
      await visit(childPath, depth + 1)
    }
  }

  await visit(args.path, 0)
  return {
    selectedPath: args.path,
    selectedPathKind: 'non_git_folder',
    repos,
    truncated,
    timedOut,
    durationMs: Date.now() - startedAt,
    maxDepth: options.maxDepth
  }
}
