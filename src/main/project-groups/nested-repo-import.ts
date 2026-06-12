import type { NestedRepoScanResult, ProjectGroup, ProjectGroupImportMode } from '../../shared/types'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/cross-platform-path'

type CreateGroupInput = {
  name: string
  parentPath?: string | null
  connectionId?: string | null
  parentGroupId?: string | null
  createdFrom: ProjectGroup['createdFrom']
}

type NestedProjectGroupResolver = {
  getGroupForRepo: (repoPath: string) => ProjectGroup | undefined
  getRootGroup: () => ProjectGroup | undefined
  getCreatedGroups: () => ProjectGroup[]
}

export type ResolvedNestedRepoSelection = {
  selectedPaths: string[]
  rejectedPaths: string[]
}

type FolderScope = {
  relativePath: string
  name: string
  folderPath: string
  parentRelativePath: string | null
}

function canonicalizeImportPath(path: string): string | null {
  if (!isRuntimePathAbsolute(path)) {
    return null
  }
  return resolveRuntimePath(path, path)
}

function trimPathSeparators(path: string): string {
  if (path === '/' || /^[A-Za-z]:[\\/]?$/.test(path)) {
    return path.replace(/\\/g, '/')
  }
  if (/^\/\/[^/]+\/[^/]+\/?$/.test(path.replace(/\\/g, '/'))) {
    return path.replace(/\\/g, '/').replace(/\/$/, '')
  }
  return path.replace(/\\/g, '/').replace(/\/+$/g, '')
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
}

function getFolderRelativePathForRepo(parentPath: string, repoPath: string): string | null {
  const relativePath = relativePathInsideRoot(parentPath, repoPath)
  if (relativePath === null || relativePath === '') {
    return null
  }
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  segments.pop()
  return segments.join('/')
}

function resolveFolderPath(parentPath: string, relativePath: string): string {
  return trimPathSeparators(resolveRuntimePath(parentPath, relativePath))
}

function getNearestScopePath(
  relativePath: string,
  scopePaths: { has: (value: string) => boolean }
): string | null {
  const segments = normalizeRelativePath(relativePath).split('/').filter(Boolean)
  for (let length = segments.length; length > 0; length -= 1) {
    const candidate = segments.slice(0, length).join('/')
    if (scopePaths.has(candidate)) {
      return candidate
    }
  }
  return null
}

function buildSparseFolderScopes(args: {
  parentPath: string
  repoPaths: readonly string[]
}): FolderScope[] {
  // Why: folder-backed workspaces should expose meaningful launch scopes
  // without turning every one-child filesystem segment into sidebar structure.
  const folderStats = new Map<string, { directRepoCount: number; totalRepoCount: number }>()
  const noteFolder = (relativePath: string, field: 'directRepoCount' | 'totalRepoCount'): void => {
    const normalized = normalizeRelativePath(relativePath)
    const stats = folderStats.get(normalized) ?? { directRepoCount: 0, totalRepoCount: 0 }
    stats[field] += 1
    folderStats.set(normalized, stats)
  }

  for (const repoPath of args.repoPaths) {
    const folderRelativePath = getFolderRelativePathForRepo(args.parentPath, repoPath)
    if (folderRelativePath === null) {
      continue
    }
    noteFolder(folderRelativePath, 'directRepoCount')
    const segments = folderRelativePath.split('/').filter(Boolean)
    for (let length = 1; length <= segments.length; length += 1) {
      noteFolder(segments.slice(0, length).join('/'), 'totalRepoCount')
    }
  }

  const meaningfulPaths = [...folderStats.entries()]
    .filter(([relativePath, stats]) => {
      if (!relativePath) {
        return false
      }
      return (
        stats.directRepoCount >= 2 ||
        (stats.directRepoCount > 0 && stats.totalRepoCount > stats.directRepoCount)
      )
    })
    .map(([relativePath]) => relativePath)
    .sort(
      (left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right)
    )
  const meaningfulPathSet = new Set(meaningfulPaths)

  return meaningfulPaths.map((relativePath) => {
    const parentRelativePath =
      getNearestScopePath(relativePath.split('/').slice(0, -1).join('/'), meaningfulPathSet) ?? null
    return {
      relativePath,
      name: relativePath,
      folderPath: resolveFolderPath(args.parentPath, relativePath),
      parentRelativePath
    }
  })
}

export function createNestedProjectGroupResolver(args: {
  parentPath: string
  groupName: string
  mode: ProjectGroupImportMode
  connectionId?: string | null
  repoPaths?: readonly string[]
  createGroup: (input: CreateGroupInput) => ProjectGroup
}): NestedProjectGroupResolver {
  const createdGroups: ProjectGroup[] = []
  const folderScopes = buildSparseFolderScopes({
    parentPath: args.parentPath,
    repoPaths: args.repoPaths ?? []
  })
  const folderScopesByRelativePath = new Map(
    folderScopes.map((scope) => [scope.relativePath, scope])
  )
  const folderScopeGroups = new Map<string, ProjectGroup>()
  let rootGroup: ProjectGroup | undefined

  const ensureRootGroup = (): ProjectGroup | undefined => {
    if (args.mode !== 'group') {
      return undefined
    }
    if (rootGroup) {
      return rootGroup
    }
    const fallbackName = getRuntimePathBasename(trimPathSeparators(args.parentPath))
    rootGroup = args.createGroup({
      name: args.groupName.trim() || fallbackName,
      parentPath: trimPathSeparators(args.parentPath),
      connectionId: args.connectionId ?? null,
      parentGroupId: null,
      createdFrom: 'folder-scan'
    })
    createdGroups.push(rootGroup)
    return rootGroup
  }

  const ensureFolderScopeGroup = (relativePath: string): ProjectGroup | undefined => {
    const root = ensureRootGroup()
    if (!root) {
      return undefined
    }
    const existing = folderScopeGroups.get(relativePath)
    if (existing) {
      return existing
    }
    const scope = folderScopesByRelativePath.get(relativePath)
    if (!scope) {
      return root
    }
    const parentGroup = scope.parentRelativePath
      ? ensureFolderScopeGroup(scope.parentRelativePath)
      : root
    const group = args.createGroup({
      name: scope.name,
      parentPath: scope.folderPath,
      connectionId: args.connectionId ?? null,
      parentGroupId: parentGroup?.id ?? root.id,
      createdFrom: 'folder-scan'
    })
    folderScopeGroups.set(relativePath, group)
    createdGroups.push(group)
    return group
  }

  return {
    getGroupForRepo: (repoPath) => {
      const root = ensureRootGroup()
      if (!root) {
        return undefined
      }
      const folderRelativePath = getFolderRelativePathForRepo(args.parentPath, repoPath)
      const scopePath = folderRelativePath
        ? getNearestScopePath(folderRelativePath, folderScopesByRelativePath)
        : null
      return scopePath ? ensureFolderScopeGroup(scopePath) : root
    },
    getRootGroup: () => rootGroup,
    getCreatedGroups: () => [...createdGroups]
  }
}

export function resolveNestedRepoSelection(args: {
  scan: NestedRepoScanResult
  projectPaths: readonly string[]
}): ResolvedNestedRepoSelection {
  const candidatesByPath = new Map(
    args.scan.repos.map((repo) => [normalizeRuntimePathForComparison(repo.path), repo.path])
  )
  const selectedPaths: string[] = []
  const rejectedPaths: string[] = []
  const seen = new Set<string>()

  for (const repoPath of args.projectPaths) {
    const normalizedPath = normalizeRuntimePathForComparison(repoPath)
    if (seen.has(normalizedPath)) {
      continue
    }
    seen.add(normalizedPath)
    const canonicalPath = candidatesByPath.get(normalizedPath)
    if (canonicalPath) {
      selectedPaths.push(canonicalPath)
    } else {
      // Why: imports are derived from a bounded scan of this parent folder;
      // callers must not smuggle unrelated paths into the group hierarchy.
      rejectedPaths.push(repoPath)
    }
  }

  return { selectedPaths, rejectedPaths }
}

export function resolveNestedRepoImportPaths(args: {
  parentPath: string
  projectPaths: readonly string[]
}): ResolvedNestedRepoSelection {
  const selectedPaths: string[] = []
  const rejectedPaths: string[] = []
  const seen = new Set<string>()
  const canonicalParentPath = canonicalizeImportPath(args.parentPath)

  if (!canonicalParentPath) {
    return { selectedPaths, rejectedPaths: [...args.projectPaths] }
  }
  const normalizedParentPath = normalizeRuntimePathForComparison(canonicalParentPath)

  for (const repoPath of args.projectPaths) {
    const canonicalRepoPath = canonicalizeImportPath(repoPath)
    const normalizedPath = canonicalRepoPath
      ? normalizeRuntimePathForComparison(canonicalRepoPath)
      : normalizeRuntimePathForComparison(repoPath)
    if (seen.has(normalizedPath)) {
      continue
    }
    seen.add(normalizedPath)
    if (
      !canonicalRepoPath ||
      normalizedPath === normalizedParentPath ||
      !isPathInsideOrEqual(canonicalParentPath, canonicalRepoPath)
    ) {
      // Why: stopped scans import a caller-provided partial selection, so the
      // parent boundary still blocks dot-segment escapes without rescanning.
      rejectedPaths.push(repoPath)
      continue
    }
    selectedPaths.push(canonicalRepoPath)
  }

  return { selectedPaths, rejectedPaths }
}
