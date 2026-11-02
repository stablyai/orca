import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'
import {
  EMPTY_HEAD_IDENTITY_SCOPE,
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityScopeForEntry,
  LISTING_HEAD_IDENTITY_SCOPE,
  mergeHeadIdentityScopes,
  PRIMARY_HEAD_IDENTITY_SCOPE,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

type WorktreeBaseWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
}

export type WorktreeBaseChangeClass = {
  structureRepoIds: string[]
  gitStatusRepoIds: string[]
  // Head moves refresh status plus head identity; index churn must stay status-only.
  headIdentityRepoIds: string[]
  // Every classification states its scope; EMPTY proves no head moved.
  headIdentityScope: WorktreeHeadIdentityScope
  // Attribute status to worktrees; FULL means the change cannot be narrowed.
  gitStatusScope: WorktreeHeadIdentityScope
}

export type WorktreeBaseWatchKind = 'base' | 'git-common'

export type WorktreeBaseRepoWatchConfig = {
  repoId: string
  repoName: string
  nestWorkspaces: boolean
}

export type WorktreeBaseWatchTarget = {
  key: string
  kind: WorktreeBaseWatchKind
  path: string
  repos: Map<string, WorktreeBaseRepoWatchConfig>
  /** Exact upstream leaf selected by accepted active-worktree status. */
  gitStatusRefPaths?: ReadonlySet<string>
}

export function pathRelativeToWorktreeWatchRoot(
  rootPath: string,
  candidatePath: string
): string[] | null {
  const relativePath = relativePathInsideRoot(rootPath, candidatePath)
  if (relativePath === null) {
    return null
  }
  return relativePath.split(/[\\/]+/).filter(Boolean)
}

function isRootCompletionEvent(parts: string[], config: WorktreeBaseRepoWatchConfig): boolean {
  if (config.nestWorkspaces) {
    return (
      parts.length === 2 &&
      normalizeRuntimePathForComparison(parts[0]) ===
        normalizeRuntimePathForComparison(config.repoName)
    )
  }
  return parts.length === 1
}

// Root creation may precede Git registration; .git marks checkout completion.
function isGitMarkerCompletionEvent(parts: string[], config: WorktreeBaseRepoWatchConfig): boolean {
  if (config.nestWorkspaces) {
    return (
      parts.length === 3 &&
      normalizeRuntimePathForComparison(parts[0]) ===
        normalizeRuntimePathForComparison(config.repoName) &&
      parts[2] === '.git'
    )
  }
  return parts.length === 2 && parts[1] === '.git'
}

function matchingBaseRepoIds(
  target: WorktreeBaseWatchTarget,
  eventPath: string,
  eventType: string
): string[] {
  const repoIds: string[] = []
  const parts = pathRelativeToWorktreeWatchRoot(target.path, eventPath)
  if (!parts) {
    return repoIds
  }

  for (const config of target.repos.values()) {
    if (
      isGitMarkerCompletionEvent(parts, config) ||
      (eventType === 'delete' && isRootCompletionEvent(parts, config))
    ) {
      repoIds.push(config.repoId)
    }
  }
  return repoIds
}

// Primary metadata affects checkout state; config.worktree changes only listing structure, while packed-refs can move any head.
const GIT_COMMON_PRIMARY_STRUCTURAL_SCOPES = new Map<string, WorktreeHeadIdentityScope>([
  ['HEAD', PRIMARY_HEAD_IDENTITY_SCOPE],
  ['packed-refs', FULL_HEAD_IDENTITY_SCOPE],
  ['config.worktree', EMPTY_HEAD_IDENTITY_SCOPE]
])
const GIT_COMMON_LINKED_STRUCTURAL_FILES = new Set(['HEAD', 'gitdir', 'locked', 'config.worktree'])
// HEAD/gitdir affect identity; locked/config.worktree change structure without moving heads.
const GIT_COMMON_LINKED_HEAD_SOURCE_FILES = new Set(['HEAD', 'gitdir'])
const GIT_COMMON_LINKED_STATUS_FILES = new Set(['index'])

// logs/HEAD captures amend/reset moves without index/HEAD leaf writes; status-only churn never appends it.
function isHeadLogParts(parts: string[], offset: number): boolean {
  return parts.length === offset + 2 && parts[offset] === 'logs' && parts[offset + 1] === 'HEAD'
}

// Only the active status result's exact upstream ref crosses the refs/** cutoff.
function isBoundUpstreamRef(
  target: WorktreeBaseWatchTarget,
  eventPath: string,
  parts: string[]
): boolean {
  if (parts.length < 2 || parts[0] !== 'refs' || parts.at(-1)?.endsWith('.lock')) {
    return false
  }
  const eventKey = normalizeRuntimePathForComparison(eventPath)
  return [...(target.gitStatusRefPaths ?? [])].some(
    (path) => normalizeRuntimePathForComparison(path) === eventKey
  )
}

function allRepoIds(target: WorktreeBaseWatchTarget): string[] {
  return [...target.repos.keys()]
}

const NO_CHANGE: WorktreeBaseChangeClass = {
  structureRepoIds: [],
  gitStatusRepoIds: [],
  headIdentityRepoIds: [],
  headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
  gitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE
}

function structuralChange(
  repoIds: string[],
  headIdentityScope: WorktreeHeadIdentityScope = EMPTY_HEAD_IDENTITY_SCOPE
): WorktreeBaseChangeClass {
  return {
    structureRepoIds: repoIds,
    gitStatusRepoIds: [],
    headIdentityRepoIds: [],
    headIdentityScope,
    gitStatusScope: EMPTY_HEAD_IDENTITY_SCOPE
  }
}

function gitStatusChange(
  repoIds: string[],
  gitStatusScope: WorktreeHeadIdentityScope
): WorktreeBaseChangeClass {
  return {
    structureRepoIds: [],
    gitStatusRepoIds: repoIds,
    headIdentityRepoIds: [],
    headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE,
    gitStatusScope
  }
}

function headIdentityChange(
  repoIds: string[],
  headIdentityScope: WorktreeHeadIdentityScope
): WorktreeBaseChangeClass {
  return {
    structureRepoIds: [],
    gitStatusRepoIds: [],
    headIdentityRepoIds: repoIds,
    headIdentityScope,
    // Shared branch moves can change any checkout's local upstream; refs/heads are not polled directly.
    gitStatusScope: FULL_HEAD_IDENTITY_SCOPE
  }
}

// Git common worktree metadata avoids watching high-churn checkout contents.
function classifyGitCommonEvent(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent
): WorktreeBaseChangeClass {
  const parts = pathRelativeToWorktreeWatchRoot(target.path, event.path)
  if (!parts) {
    return NO_CHANGE
  }
  const repoIds = allRepoIds(target)
  if (parts.length === 1) {
    if (parts[0] === 'worktrees') {
      // Admin-root replacement invalidates the watcher's view of every entry.
      return structuralChange(repoIds, FULL_HEAD_IDENTITY_SCOPE)
    }
    const primaryScope = GIT_COMMON_PRIMARY_STRUCTURAL_SCOPES.get(parts[0])
    if (primaryScope) {
      return structuralChange(repoIds, primaryScope)
    }
    if (parts[0] === 'index') {
      return gitStatusChange(repoIds, PRIMARY_HEAD_IDENTITY_SCOPE)
    }
    if (parts[0] === 'config') {
      // External push -u changes shared upstream config without moving a head or listing.
      return gitStatusChange(repoIds, FULL_HEAD_IDENTITY_SCOPE)
    }
    return NO_CHANGE
  }
  if (parts[0] !== 'worktrees') {
    if (isHeadLogParts(parts, 0)) {
      return headIdentityChange(repoIds, PRIMARY_HEAD_IDENTITY_SCOPE)
    }
    // Bound to the active status result, so it must reach it whoever wrote it.
    if (isBoundUpstreamRef(target, event.path, parts)) {
      return gitStatusChange(repoIds, FULL_HEAD_IDENTITY_SCOPE)
    }
    return NO_CHANGE
  }
  if (parts.length === 2) {
    // Reused admin-directory names need identity invalidation beyond a listing-only refresh.
    return event.type === 'update'
      ? NO_CHANGE
      : structuralChange(
          repoIds,
          mergeHeadIdentityScopes(LISTING_HEAD_IDENTITY_SCOPE, headIdentityScopeForEntry(parts[1]))
        )
  }
  if (parts.length === 3) {
    if (GIT_COMMON_LINKED_STRUCTURAL_FILES.has(parts[2])) {
      return structuralChange(
        repoIds,
        GIT_COMMON_LINKED_HEAD_SOURCE_FILES.has(parts[2])
          ? headIdentityScopeForEntry(parts[1])
          : EMPTY_HEAD_IDENTITY_SCOPE
      )
    }
    if (GIT_COMMON_LINKED_STATUS_FILES.has(parts[2])) {
      return gitStatusChange(repoIds, headIdentityScopeForEntry(parts[1]))
    }
  }
  if (isHeadLogParts(parts, 2)) {
    return headIdentityChange(repoIds, headIdentityScopeForEntry(parts[1]))
  }
  return NO_CHANGE
}

function classifyBaseEvent(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent
): WorktreeBaseChangeClass {
  return structuralChange(matchingBaseRepoIds(target, event.path, event.type))
}

export function classifyWorktreeBaseChange(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent
): WorktreeBaseChangeClass {
  return target.kind === 'git-common'
    ? classifyGitCommonEvent(target, event)
    : classifyBaseEvent(target, event)
}

export function matchingWorktreeBaseRepoIds(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent
): string[] {
  return classifyWorktreeBaseChange(target, event).structureRepoIds
}
