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
  // logs/HEAD and other true head-move triggers: notify Source Control like
  // status churn, but distinct so only these re-read head identities. An index
  // rewrite cannot move HEAD, so it must never land here.
  headIdentityRepoIds: string[]
  // Which slice of the common dir's head identities this event can have moved.
  // Every classification must state one; `EMPTY` is a claim that no head moved.
  headIdentityScope: WorktreeHeadIdentityScope
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
  connectionId?: string
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

// Why: root creation can arrive before Git finishes registration; the `.git`
// marker is the checkout-complete signal, while deeper file churn is ignored.
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

// Why: branch switches and commits in the primary checkout rewrite these
// top-level common-dir files; matching them keeps root-checkout branch/status
// as fresh as linked worktrees. Deeper churn (objects, refs/heads, logs) is
// ignored.
// `config.worktree` is structural because it is the only file whose write
// flips `git worktree list`'s sparse flag, and no status/commit path touches
// it — so it cannot re-open the index-churn fanout this classifier closes, and
// it can move no head either. A rewritten `packed-refs` by contrast can move
// any branch oid without touching a single admin dir, so no cached head
// survives it.
const GIT_COMMON_PRIMARY_STRUCTURAL_SCOPES = new Map<string, WorktreeHeadIdentityScope>([
  ['HEAD', PRIMARY_HEAD_IDENTITY_SCOPE],
  ['packed-refs', FULL_HEAD_IDENTITY_SCOPE],
  ['config.worktree', EMPTY_HEAD_IDENTITY_SCOPE]
])
// `config` is status-tier: an external `git push -u` writes only
// branch.<name>.remote/merge there, and a config write can move neither HEAD
// nor the worktree listing.
const GIT_COMMON_PRIMARY_STATUS_FILES = new Set(['index', 'config'])
const GIT_COMMON_LINKED_STRUCTURAL_FILES = new Set(['HEAD', 'gitdir', 'locked', 'config.worktree'])
// `HEAD` carries the branch and `gitdir` the checkout path; `locked` and
// `config.worktree` are written by `git worktree lock` / sparse toggles, neither
// of which can move a head.
const GIT_COMMON_LINKED_HEAD_SOURCE_FILES = new Set(['HEAD', 'gitdir'])
const GIT_COMMON_LINKED_STATUS_FILES = new Set(['index'])

// `logs/HEAD` is the head-identity trigger for head moves that rewrite no
// watched leaf (commit --amend, reset --soft): every ref update through a
// checkout appends there, while `git status` churn never touches it. It is
// kept separate from index churn so only these events re-read head identities.
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
  headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE
}

function structuralChange(
  repoIds: string[],
  headIdentityScope: WorktreeHeadIdentityScope = EMPTY_HEAD_IDENTITY_SCOPE
): WorktreeBaseChangeClass {
  return {
    structureRepoIds: repoIds,
    gitStatusRepoIds: [],
    headIdentityRepoIds: [],
    headIdentityScope
  }
}

function gitStatusChange(repoIds: string[]): WorktreeBaseChangeClass {
  return {
    structureRepoIds: [],
    gitStatusRepoIds: repoIds,
    headIdentityRepoIds: [],
    headIdentityScope: EMPTY_HEAD_IDENTITY_SCOPE
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
    headIdentityScope
  }
}

// Why: Git records linked worktrees under the common dir's `worktrees`
// metadata, which is lower churn than watching checkout contents.
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
      // The admin root itself appearing, vanishing, or being swapped means the
      // watcher's view of every entry is suspect.
      return structuralChange(repoIds, FULL_HEAD_IDENTITY_SCOPE)
    }
    const primaryScope = GIT_COMMON_PRIMARY_STRUCTURAL_SCOPES.get(parts[0])
    if (primaryScope) {
      return structuralChange(repoIds, primaryScope)
    }
    if (GIT_COMMON_PRIMARY_STATUS_FILES.has(parts[0])) {
      return gitStatusChange(repoIds)
    }
    return NO_CHANGE
  }
  if (parts[0] !== 'worktrees') {
    if (isHeadLogParts(parts, 0)) {
      return headIdentityChange(repoIds, PRIMARY_HEAD_IDENTITY_SCOPE)
    }
    if (isBoundUpstreamRef(target, event.path, parts)) {
      return gitStatusChange(repoIds)
    }
    return NO_CHANGE
  }
  if (parts.length === 2) {
    // Name the entry as well as the listing: a remove+add reusing one admin dir
    // name coalesces into a single refresh, and the listing alone would keep
    // serving the removed worktree's cached head.
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
      return gitStatusChange(repoIds)
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
