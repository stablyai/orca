import type { NestedRepoScanResult, ProjectGroup, ProjectGroupImportMode } from '../../shared/types'
import {
  getRuntimePathBasename,
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison,
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

export function createNestedProjectGroupResolver(args: {
  parentPath: string
  groupName: string
  mode: ProjectGroupImportMode
  createGroup: (input: CreateGroupInput) => ProjectGroup
}): NestedProjectGroupResolver {
  const createdGroups: ProjectGroup[] = []
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
      parentGroupId: null,
      createdFrom: 'folder-scan'
    })
    createdGroups.push(rootGroup)
    return rootGroup
  }

  return {
    getGroupForRepo: () => ensureRootGroup(),
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
