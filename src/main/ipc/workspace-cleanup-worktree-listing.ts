import type { Store } from '../persistence'
import { listRepoWorktrees, createFolderWorktree } from '../repo-worktrees'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { IGitProvider } from '../providers/types'
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
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export async function listCleanupGitWorktrees(
  store: Store,
  repo: Repo,
  repoIsFolder: boolean,
  signal?: AbortSignal
): Promise<{ provider: IGitProvider | null; gitWorktrees: GitWorktreeInfo[] }> {
  if (repoIsFolder) {
    return {
      provider: repo.connectionId ? (getSshGitProvider(repo.connectionId) ?? null) : null,
      gitWorktrees: [createFolderWorktree(repo)]
    }
  }
  if (repo.connectionId) {
    const provider = getSshGitProvider(repo.connectionId) ?? null
    if (!provider) {
      // Why: cleanup should reflect only workspaces Orca can currently inspect.
      return { provider: null, gitWorktrees: [] }
    }
    return {
      provider,
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
    provider: null,
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
  console.error('Workspace cleanup repo scan failed', error)
  if (repo.connectionId && !targeted) {
    // Why: broad cleanup only shows remote workspaces Orca can inspect now.
    // A connected SSH repo that fails mid-scan is omitted, not bannered.
    return { scannedAt, candidates: [], errors: [] }
  }
  const errors = [createWorkspaceCleanupScanError(repo, toSafeWorkspaceCleanupRepoScanError(error))]
  onErrors?.(errors)
  return { scannedAt, candidates: [], errors }
}
