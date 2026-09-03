// Folder workspaces use synthetic worktree ids (`folder:<id>`). git.status /
// git.diff are routed for them (#10819); other SC git RPCs are not and always
// throw selector_not_found. Mobile must degrade instead of retrying.

export const MOBILE_FOLDER_WORKSPACE_ID_PREFIX = 'folder:'

export const MOBILE_FOLDER_WORKSPACE_UNSUPPORTED_MESSAGE =
  'Not available for folder workspaces'

export const MOBILE_FOLDER_WORKSPACE_BRANCH_LABEL = 'Folder workspace'

// Only git.status / git.diff are routed for folder selectors (#10819). Any other
// git.* RPC is structurally unrouted — denylist would miss git.commit, etc.
const MOBILE_FOLDER_WORKSPACE_ROUTED_GIT_METHODS = new Set(['git.status', 'git.diff'])

export function isMobileFolderWorkspaceId(worktreeId: string): boolean {
  return worktreeId.startsWith(MOBILE_FOLDER_WORKSPACE_ID_PREFIX)
}

// Real worktrees can emit selector_not_found while still being created; folder
// ids never resolve for unrouted methods, so retries only slow the failure.
export function shouldRetryMobileStatusSelectorNotFound(worktreeId: string): boolean {
  return !isMobileFolderWorkspaceId(worktreeId)
}

export function shouldLoadMobileBranchCompare(worktreeId: string): boolean {
  return !isMobileFolderWorkspaceId(worktreeId)
}

export function isMobileFolderWorkspaceUnroutedGitMethod(method: string): boolean {
  return method.startsWith('git.') && !MOBILE_FOLDER_WORKSPACE_ROUTED_GIT_METHODS.has(method)
}

export function mobileFolderWorkspaceGitRpcGuard(
  worktreeId: string,
  method: string
): { allowed: true } | { allowed: false; message: string } {
  if (
    isMobileFolderWorkspaceId(worktreeId) &&
    isMobileFolderWorkspaceUnroutedGitMethod(method)
  ) {
    return { allowed: false, message: MOBILE_FOLDER_WORKSPACE_UNSUPPORTED_MESSAGE }
  }
  return { allowed: true }
}

// Folder multi-repo status intentionally leaves branch/head unset — show a
// workspace label instead of "No branch" / blank identity. Mirrors
// formatBranchLabel for the non-empty cases so this file stays free of UI
// imports (lucide) that break pure unit tests.
export function formatMobileFolderAwareBranchLabel(
  worktreeId: string,
  branch: string | undefined,
  head: string | undefined
): string {
  if (branch?.startsWith('refs/heads/')) {
    return branch.slice('refs/heads/'.length)
  }
  if (branch) {
    return branch
  }
  if (head) {
    return head.slice(0, 7)
  }
  if (isMobileFolderWorkspaceId(worktreeId)) {
    return MOBILE_FOLDER_WORKSPACE_BRANCH_LABEL
  }
  return 'No branch'
}
