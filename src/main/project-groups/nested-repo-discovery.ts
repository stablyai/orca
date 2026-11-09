import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { NestedRepoCandidate, NestedRepoScanResult } from '../../shared/project-group-types'
import { isGitRepoAsync } from '../git/repo'
import { awaitWindowsHostGitEnvironmentReady } from '../git/runner'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  isIgnoredNestedRepoDirectory,
  normalizeNestedRepoScanOptions,
  readNestedRepoGitignoreRules,
  type NestedRepoDirectoryEntry,
  type NestedRepoScanFilesystem,
  type TraversalFolder
} from './nested-repo-scan-rules'

async function probeGitMarkers(dirPath: string): Promise<{
  hasGitMarker: boolean
  possibleGitMarker: boolean
}> {
  let possibleGitMarker = false
  const readMarker = async (name: string) => {
    const path = join(dirPath, name)
    try {
      const entry = await lstat(path)
      // Entry presence includes broken links and incomplete metadata; Git remains authoritative.
      possibleGitMarker = true
      return entry.isSymbolicLink() ? await stat(path).catch(() => null) : entry
    } catch (error) {
      if (
        !error ||
        typeof error !== 'object' ||
        !('code' in error) ||
        (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')
      ) {
        possibleGitMarker = true
      }
      return null
    }
  }
  const marker = await readMarker('.git')
  if (marker?.isDirectory() === true || marker?.isFile() === true) {
    return { hasGitMarker: true, possibleGitMarker: true }
  }
  const [head, objects, refs] = await Promise.all(['HEAD', 'objects', 'refs'].map(readMarker))
  return {
    hasGitMarker:
      head?.isFile() === true && objects?.isDirectory() === true && refs?.isDirectory() === true,
    possibleGitMarker
  }
}

async function hasGitMarker(dirPath: string): Promise<boolean> {
  return (await probeGitMarkers(dirPath)).hasGitMarker
}

async function mayNeedGitDiscovery(path: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }
  try {
    if (process.platform === 'win32') {
      // WSL can discover Git through its shell environment rather than this process's environment.
      if (parseWslUncPath(path)) {
        return true
      }
      await awaitWindowsHostGitEnvironmentReady({ cwd: path })
    }
    if (
      process.env.GIT_DIR !== undefined ||
      process.env.GIT_WORK_TREE !== undefined ||
      process.env.GIT_COMMON_DIR !== undefined ||
      Object.keys(process.env).some((key) =>
        (process.platform === 'win32' ? key.toUpperCase() : key).startsWith('GIT_CONFIG')
      )
    ) {
      return true
    }
    const roots = new Set([resolve(path), await realpath(path)])
    for (const root of roots) {
      let current = root
      while (true) {
        if (signal?.aborted) {
          return false
        }
        const markers = await probeGitMarkers(current)
        if (markers.possibleGitMarker) {
          return true
        }
        const parent = dirname(current)
        if (parent === current) {
          break
        }
        current = parent
      }
    }
    return false
  } catch {
    return true
  }
}

async function readLocalDirectory(dirPath: string): Promise<NestedRepoDirectoryEntry[]> {
  // Dirents avoid per-child stat and prevent symlink traversal outside the selected folder.
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
  const options = normalizeNestedRepoScanOptions(args.options)
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
    isSelectedPathGitRepo: async (path: string) =>
      (await mayNeedGitDiscovery(path, args.signal)) &&
      !args.signal?.aborted &&
      ((await isGitRepoAsync(path)) || (await hasGitMarker(path)))
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

  const foldersToTraverse: (TraversalFolder | undefined)[] = [
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
    const currentFolder = foldersToTraverse[nextFolderIndex++]!
    // Release processed paths and inherited ignore rules before the next filesystem await.
    foldersToTraverse[nextFolderIndex - 1] = undefined
    if (nextFolderIndex >= 64 && nextFolderIndex * 2 >= foldersToTraverse.length) {
      foldersToTraverse.splice(0, nextFolderIndex)
      nextFolderIndex = 0
    }
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
    const currentIgnoreRules = [
      ...currentFolder.ignoreRules,
      ...(await readNestedRepoGitignoreRules({
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
      if (isIgnoredNestedRepoDirectory(name, childSegments, currentIgnoreRules)) {
        continue
      }
      const childPath = filesystem.joinPath(currentFolder.path, name)
      // Filesystem markers avoid per-directory Git spawns, especially over SSH.
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
        // Hide submodule-style descendants until the group UI supports selecting them.
        continue
      }
      // Breadth-first traversal spends the bounded scan on nearby siblings before deep branches.
      if (currentFolder.depth < options.maxDepth) {
        foldersToTraverse.push({
          path: childPath,
          depth: currentFolder.depth + 1,
          segments: childSegments,
          ignoreRules: currentIgnoreRules
        })
      }
    }
  }

  return buildResult('non_git_folder')
}
