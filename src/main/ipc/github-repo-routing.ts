import { resolve } from 'node:path'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import type {
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult
} from '../../shared/github/pull-request-refresh-types'
import type { Repo } from '../../shared/repo-types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import {
  notePRRefreshValidationDenial,
  type PRRefreshValidationDenialReason
} from '../github/pr-refresh-validation-backoff'
import type { Store } from '../persistence'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'

export type GitHubRepoScopedArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

type RegisteredRepoValidationResult =
  | { kind: 'ok'; repo: Repo }
  | { kind: 'denied'; reason: PRRefreshValidationDenialReason; message: string }

function validateRegisteredRepo(
  args: string | GitHubRepoScopedArgs,
  store: Store,
  repos = store.getRepos()
): RegisteredRepoValidationResult {
  const repoPath = typeof args === 'string' ? args : args.repoPath
  const repoId = typeof args === 'string' ? undefined : args.repoId
  const resolvedRepoPath = resolve(repoPath)
  const repo = repos.find((candidate) =>
    repoId ? candidate.id === repoId : resolve(candidate.path) === resolvedRepoPath
  )
  if (!repo) {
    return {
      kind: 'denied',
      reason: 'unknown-repo',
      message: 'Access denied: unknown repository path'
    }
  }
  if (repoId && resolve(repo.path) !== resolvedRepoPath) {
    return {
      kind: 'denied',
      reason: 'repo-path-mismatch',
      message: 'Access denied: repository path does not match repo id'
    }
  }
  if (
    typeof args !== 'string' &&
    args.sourceContext?.provider === 'github' &&
    args.sourceContext.hostId !== getRepoExecutionHostId(repo)
  ) {
    return {
      kind: 'denied',
      reason: 'host-mismatch',
      message: 'Access denied: GitHub source host does not match repository host'
    }
  }
  return { kind: 'ok', repo }
}

export function assertRegisteredGitHubRepo(
  args: string | GitHubRepoScopedArgs,
  store: Store
): Repo {
  const result = validateRegisteredRepo(args, store)
  if (result.kind === 'denied') {
    throw new Error(result.message)
  }
  return result.repo
}

export function getGitHubRepoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

export function getGitHubLocalGitOptionArgs(
  store: Store,
  repo: Repo
): [] | [{ wslDistro?: string }] {
  const localGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  return Object.keys(localGitOptions).length > 0 ? [localGitOptions] : []
}

export function applyRegisteredRepoToPRRefreshCandidate(
  store: Store,
  repo: Repo,
  candidate: GitHubPRRefreshCandidate
): GitHubPRRefreshCandidate {
  const localGitOptions = getGitHubLocalGitOptionArgs(store, repo)[0]
  const appliedCandidate = { ...candidate }
  delete appliedCandidate.localGitOptions
  delete appliedCandidate.connectionId
  delete appliedCandidate.executionHostId
  delete appliedCandidate.connectionState
  return {
    ...appliedCandidate,
    repoPath: repo.path,
    repoId: repo.id,
    ...(localGitOptions ? { localGitOptions } : {}),
    connectionId: getGitHubRepoConnectionId(repo),
    executionHostId: repo.executionHostId ?? null,
    connectionState: repo.connectionId ? 'connected' : 'unknown'
  }
}

export function validateAutomaticPRRefreshCandidate(
  candidate: GitHubPRRefreshCandidate,
  store: Store,
  repos = store.getRepos()
):
  | { kind: 'ok'; candidate: GitHubPRRefreshCandidate }
  | { kind: 'skipped'; result: Extract<GitHubPRRefreshEnqueueResult, { kind: 'skipped' }> } {
  const result = validateRegisteredRepo(candidate, store, repos)
  if (result.kind === 'denied') {
    const skippedReason = notePRRefreshValidationDenial({
      repoId: candidate.repoId,
      repoPath: candidate.repoPath,
      reason: result.reason
    })
    return { kind: 'skipped', result: { kind: 'skipped', skippedReason } }
  }
  return {
    kind: 'ok',
    candidate: applyRegisteredRepoToPRRefreshCandidate(store, result.repo, candidate)
  }
}
