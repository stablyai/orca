import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type {
  NestedRepoCandidate,
  NestedRepoScanDiagnostic,
  NestedRepoScanDiagnostics,
  NestedRepoScanResult
} from '../../shared/project-group-types'
import { isGitRepo } from '../git/repo'
import {
  getNestedRepoDirectoryExclusion,
  normalizeNestedRepoScanOptions,
  readNestedRepoGitignoreRules,
  type NestedRepoDirectoryEntry,
  type NestedRepoScanFilesystem,
  type TraversalFolder
} from './nested-repo-scan-rules'

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
  const options = normalizeNestedRepoScanOptions(args.options)
  const repos: NestedRepoCandidate[] = []
  const diagnostics: NestedRepoScanDiagnostics = { counts: {}, details: [], omittedDetails: 0 }
  const record = (detail: NestedRepoScanDiagnostic): void => {
    diagnostics.counts[detail.reason] = (diagnostics.counts[detail.reason] ?? 0) + 1
    if (diagnostics.details.length >= 100) {
      diagnostics.omittedDetails++
      return
    }
    const shorten = (value: string, limit: number): string => {
      if (value.length <= limit) {
        return value
      }
      detail.shortened = true
      return `${value.slice(0, limit)}…`
    }
    diagnostics.details.push({
      ...detail,
      path: shorten(detail.path, 2048),
      ...(detail.ignoreFile ? { ignoreFile: shorten(detail.ignoreFile, 2048) } : {}),
      ...(detail.rule ? { rule: shorten(detail.rule, 1024) } : {}),
      ...(detail.errorCode ? { errorCode: shorten(detail.errorCode, 64) } : {}),
      ...(detail.shortened ? { shortened: true } : {})
    })
  }
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
    timeoutMs: options.timeoutMs,
    diagnostics: {
      counts: { ...diagnostics.counts },
      details: [...diagnostics.details],
      omittedDetails: diagnostics.omittedDetails
    }
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
    } catch (error) {
      record({
        path: currentFolder.path,
        reason: 'unreadable',
        ...(error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? { errorCode: error.code }
          : {})
      })
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
      .filter((entry) => {
        if (entry.isSymlink) {
          record({ path: filesystem.joinPath(currentFolder.path, entry.name), reason: 'symlink' })
        }
        return entry.isDirectory && !entry.isSymlink
      })
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
      const childPath = filesystem.joinPath(currentFolder.path, name)
      const exclusion = getNestedRepoDirectoryExclusion(name, childSegments, currentIgnoreRules)
      if (exclusion) {
        record({ path: childPath, ...exclusion })
        continue
      }
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
      } else {
        record({ path: childPath, reason: 'depth-limit' })
      }
    }
  }

  return buildResult('non_git_folder')
}
