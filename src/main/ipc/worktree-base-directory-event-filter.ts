import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'

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
// as fresh as linked worktrees. Deeper churn (objects, refs, logs) is ignored.
// `config.worktree` is structural because it is the only file whose write
// flips `git worktree list`'s sparse flag, and no status/commit path touches
// it — so it cannot re-open the index-churn fanout this classifier closes.
const GIT_COMMON_PRIMARY_STRUCTURAL_FILES = new Set(['HEAD', 'packed-refs', 'config.worktree'])
const GIT_COMMON_PRIMARY_STATUS_FILES = new Set(['index'])
const GIT_COMMON_LINKED_STRUCTURAL_FILES = new Set(['HEAD', 'gitdir', 'locked', 'config.worktree'])
const GIT_COMMON_LINKED_STATUS_FILES = new Set(['index'])

// `logs/HEAD` is the head-identity trigger for head moves that rewrite no
// watched leaf (commit --amend, reset --soft): every ref update through a
// checkout appends there, while `git status` churn never touches it. It is
// kept separate from index churn so only these events re-read head identities.
function isHeadLogParts(parts: string[], offset: number): boolean {
  return parts.length === offset + 2 && parts[offset] === 'logs' && parts[offset + 1] === 'HEAD'
}

function allRepoIds(target: WorktreeBaseWatchTarget): string[] {
  return [...target.repos.keys()]
}

const NO_CHANGE: WorktreeBaseChangeClass = {
  structureRepoIds: [],
  gitStatusRepoIds: [],
  headIdentityRepoIds: []
}

function structuralChange(repoIds: string[]): WorktreeBaseChangeClass {
  return {
    structureRepoIds: repoIds,
    gitStatusRepoIds: [],
    headIdentityRepoIds: []
  }
}

function gitStatusChange(repoIds: string[]): WorktreeBaseChangeClass {
  return {
    structureRepoIds: [],
    gitStatusRepoIds: repoIds,
    headIdentityRepoIds: []
  }
}

function headIdentityChange(repoIds: string[]): WorktreeBaseChangeClass {
  return {
    structureRepoIds: [],
    gitStatusRepoIds: [],
    headIdentityRepoIds: repoIds
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
      return structuralChange(repoIds)
    }
    if (GIT_COMMON_PRIMARY_STRUCTURAL_FILES.has(parts[0])) {
      return structuralChange(repoIds)
    }
    if (GIT_COMMON_PRIMARY_STATUS_FILES.has(parts[0])) {
      return gitStatusChange(repoIds)
    }
    return NO_CHANGE
  }
  if (parts[0] !== 'worktrees') {
    if (isHeadLogParts(parts, 0)) {
      return headIdentityChange(repoIds)
    }
    return NO_CHANGE
  }
  if (parts.length === 2) {
    return event.type === 'update' ? NO_CHANGE : structuralChange(repoIds)
  }
  if (parts.length === 3) {
    if (GIT_COMMON_LINKED_STRUCTURAL_FILES.has(parts[2])) {
      return structuralChange(repoIds)
    }
    if (GIT_COMMON_LINKED_STATUS_FILES.has(parts[2])) {
      return gitStatusChange(repoIds)
    }
  }
  if (isHeadLogParts(parts, 2)) {
    return headIdentityChange(repoIds)
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
