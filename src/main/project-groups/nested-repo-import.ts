import type { NestedRepoScanResult, ProjectGroup, ProjectGroupImportMode } from '../../shared/types'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/cross-platform-path'

type CreateGroupInput = {
  name: string
  parentPath?: string | null
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
  return path.replace(/[\\/]+$/g, '')
}

function splitPath(path: string): string[] {
  return trimPathSeparators(path)
    .split(/[\\/]+/)
    .filter(Boolean)
}

function joinPath(parentPath: string, segments: readonly string[]): string {
  const trimmedParent = trimPathSeparators(parentPath)
  const separator = trimmedParent.includes('\\') && !trimmedParent.includes('/') ? '\\' : '/'
  return segments.length === 0
    ? trimmedParent
    : trimmedParent === '/'
      ? `/${segments.join('/')}`
      : trimmedParent.endsWith(separator)
        ? `${trimmedParent}${segments.join(separator)}`
        : `${trimmedParent}${separator}${segments.join(separator)}`
}

function getRelativeSegments(parentPath: string, repoPath: string): string[] {
  const relativePath = relativePathInsideRoot(parentPath, repoPath)
  if (relativePath !== null) {
    return splitPath(relativePath)
  }
  const normalizedParent = trimPathSeparators(parentPath)
  const normalizedRepo = trimPathSeparators(repoPath)
  const parentWithSeparator = `${normalizedParent}/`
  const normalizedRepoForMatch = normalizedRepo.replace(/\\/g, '/')
  const normalizedParentForMatch = normalizedParent.replace(/\\/g, '/')
  const parentWithMatchSeparator = `${normalizedParentForMatch}/`
  if (normalizedRepoForMatch.startsWith(parentWithMatchSeparator)) {
    return splitPath(normalizedRepoForMatch.slice(parentWithMatchSeparator.length))
  }
  if (normalizedRepo.startsWith(parentWithSeparator)) {
    return splitPath(normalizedRepo.slice(parentWithSeparator.length))
  }
  return splitPath(normalizedRepo).slice(-1)
}

export function createNestedProjectGroupResolver(args: {
  parentPath: string
  groupName: string
  mode: ProjectGroupImportMode
  createGroup: (input: CreateGroupInput) => ProjectGroup
}): NestedProjectGroupResolver {
  const createdGroups: ProjectGroup[] = []
  const groupsByRelativeDir = new Map<string, ProjectGroup>()

  const ensureGroup = (relativeDirs: readonly string[]): ProjectGroup | undefined => {
    if (args.mode !== 'group') {
      return undefined
    }
    const key = relativeDirs.join('/')
    const existing = groupsByRelativeDir.get(key)
    if (existing) {
      return existing
    }
    const parentDirs = relativeDirs.slice(0, -1)
    const parentGroup = relativeDirs.length > 0 ? ensureGroup(parentDirs) : undefined
    const group = args.createGroup({
      name: relativeDirs.length === 0 ? args.groupName : (relativeDirs.at(-1) ?? args.groupName),
      parentPath: joinPath(args.parentPath, relativeDirs),
      parentGroupId: parentGroup?.id ?? null,
      createdFrom: 'folder-scan'
    })
    groupsByRelativeDir.set(key, group)
    createdGroups.push(group)
    return group
  }

  return {
    getGroupForRepo: (repoPath) => {
      const segments = getRelativeSegments(args.parentPath, repoPath)
      // Why: direct child repos belong to the selected-folder group; nested repos
      // belong to the deepest intermediate directory group.
      return ensureGroup(segments.slice(0, -1))
    },
    getRootGroup: () => groupsByRelativeDir.get(''),
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
