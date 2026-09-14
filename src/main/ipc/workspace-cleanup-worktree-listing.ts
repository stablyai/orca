import type { Store } from '../persistence'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type {
  WorkspaceCleanupScanError,
  WorkspaceCleanupScanResult
} from '../../shared/workspace-cleanup'
import {
  WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
  createWorkspaceCleanupScanError,
  toSafeWorkspaceCleanupRepoScanError,
  withWorkspaceCleanupTimeout
} from './workspace-cleanup-scan-primitives'
import { ExecutionHostNotDispatchableError } from '../providers/execution-host-provider-dispatch'
import {
  isRemoteWorkspaceCleanupHost,
  resolveWorkspaceCleanupRepoGitRoute,
  type WorkspaceCleanupGitRoute
} from './workspace-cleanup-git-route'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export async function listCleanupGitWorktrees(
  store: Store,
  repo: Repo,
  repoIsFolder: boolean,
  signal?: AbortSignal
): Promise<{ route: WorkspaceCleanupGitRoute; gitWorktrees: GitWorktreeInfo[] }> {
  const route = resolveWorkspaceCleanupRepoGitRoute(repo)
  if (repoIsFolder) {
    return { route, gitWorktrees: [createFolderWorktree(repo)] }
  }
  if (route.kind === 'ssh') {
    if (!route.provider) {
      // Why: cleanup should reflect only workspaces Orca can currently inspect.
      return { route, gitWorktrees: [] }
    }
    const provider = route.provider
    return {
      route,
      gitWorktrees: await withWorkspaceCleanupTimeout(
        (signal) => provider.listWorktrees(repo.path, { signal }),
        WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
        'Timed out listing SSH worktrees.',
        signal
      )
    }
  }
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return {
    route,
    gitWorktrees: await withWorkspaceCleanupTimeout(
      (signal) => listRepoWorktrees(repo, { ...localGitOptions, signal }),
      WORKSPACE_CLEANUP_GIT_READ_TIMEOUT_MS,
      'Timed out listing worktrees.',
      signal
    )
  }
}

export function handleRepoWorktreeListError(args: {
  repo: Repo
  targeted: boolean
  scannedAt: number
  error: unknown
  onErrors?: (errors: WorkspaceCleanupScanError[]) => void
}): WorkspaceCleanupScanResult {
  const { repo, targeted, scannedAt, error, onErrors } = args
  if (error instanceof ExecutionHostNotDispatchableError) {
    // Routine for a runtime host, whose cleanup belongs to that environment's own server.
    console.warn('Workspace cleanup skipped a host this process does not execute', error.hostId)
  } else {
    console.error('Workspace cleanup repo scan failed', error)
  }
  if (isRemoteWorkspaceCleanupHost(repo) && !targeted) {
    // Why: broad cleanup only shows remote workspaces Orca can inspect now.
    // A remote repo that fails mid-scan is omitted, not bannered.
    return { scannedAt, candidates: [], errors: [] }
  }
  const errors = [createWorkspaceCleanupScanError(repo, toSafeWorkspaceCleanupRepoScanError(error))]
  onErrors?.(errors)
  return { scannedAt, candidates: [], errors }
}
