import {
  normalizeRuntimePathForComparison,
  relativePathInsideRoot
} from '../../shared/cross-platform-path'

type WorktreeBaseWatcherEvent = {
  type: 'create' | 'update' | 'delete'
  path: string
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
const GIT_COMMON_PRIMARY_METADATA_FILES = new Set(['HEAD', 'packed-refs', 'index'])

// Why: Git records linked worktrees under the common dir's `worktrees`
// metadata, which is lower churn than watching checkout contents.
function matchingGitCommonRepoIds(target: WorktreeBaseWatchTarget, eventPath: string): string[] {
  const parts = pathRelativeToWorktreeWatchRoot(target.path, eventPath)
  if (!parts) {
    return []
  }
  if (
    parts[0] !== 'worktrees' &&
    !(parts.length === 1 && GIT_COMMON_PRIMARY_METADATA_FILES.has(parts[0]))
  ) {
    return []
  }
  return [...target.repos.keys()]
}

export function matchingWorktreeBaseRepoIds(
  target: WorktreeBaseWatchTarget,
  event: WorktreeBaseWatcherEvent
): string[] {
  return target.kind === 'git-common'
    ? matchingGitCommonRepoIds(target, event.path)
    : matchingBaseRepoIds(target, event.path, event.type)
}
