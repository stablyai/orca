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
import {
  getLocalProjectGhExecOptions,
  type LocalProjectGhExecOptions
} from '../project-runtime-git-options'

export type GitHubRepoScopedArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

type RegisteredRepoValidationResult =
  | { kind: 'ok'; repo: Repo }
  | { kind: 'denied'; reason: PRRefreshValidationDenialReason; message: string }

/** A registered-repo lookup: the caller's path and id, plus the host it believes owns the row. */
type RegisteredRepoQuery = {
  repoPath: string
  repoId?: string | null
  /** Picks between twins (one id on two hosts); a lone row's own fields still win (they may be stale). */
  hostHint?: Parameters<typeof getRepoExecutionHostId>[0] | null
  sourceContext?: TaskSourceContext | null
}

function validateRegisteredRepo(
  query: RegisteredRepoQuery,
  repos: readonly Repo[]
): RegisteredRepoValidationResult {
  const { repoId, sourceContext } = query
  const resolvedRepoPath = resolve(query.repoPath)
  const idRows = repoId ? repos.filter((candidate) => candidate.id === repoId) : []
  if (repoId && idRows.length === 0) {
    return {
      kind: 'denied',
      reason: 'unknown-repo',
      message: 'Access denied: unknown repository path'
    }
  }
  // Why id and path together: a twin's rows share the id, so the first id match can be the other host.
  const pathRows = (repoId ? idRows : repos).filter(
    (candidate) => resolve(candidate.path) === resolvedRepoPath
  )
  if (pathRows.length === 0) {
    return repoId
      ? {
          kind: 'denied',
          reason: 'repo-path-mismatch',
          message: 'Access denied: repository path does not match repo id'
        }
      : {
          kind: 'denied',
          reason: 'unknown-repo',
          message: 'Access denied: unknown repository path'
        }
  }
  if (sourceContext?.provider === 'github') {
    const repo = pathRows.find(
      (candidate) => getRepoExecutionHostId(candidate) === sourceContext.hostId
    )
    return repo
      ? { kind: 'ok', repo }
      : {
          kind: 'denied',
          reason: 'host-mismatch',
          message: 'Access denied: GitHub source host does not match repository host'
        }
  }
  const hintHostId = query.hostHint ? getRepoExecutionHostId(query.hostHint) : null
  const repo =
    (hintHostId
      ? pathRows.find((candidate) => getRepoExecutionHostId(candidate) === hintHostId)
      : undefined) ?? pathRows[0]
  return { kind: 'ok', repo }
}

function registeredRepoQuery(args: string | GitHubRepoScopedArgs): RegisteredRepoQuery {
  return typeof args === 'string'
    ? { repoPath: args }
    : { repoPath: args.repoPath, repoId: args.repoId, sourceContext: args.sourceContext }
}

function prRefreshCandidateQuery(candidate: GitHubPRRefreshCandidate): RegisteredRepoQuery {
  return {
    repoPath: candidate.repoPath,
    repoId: candidate.repoId,
    hostHint: { connectionId: candidate.connectionId, executionHostId: candidate.executionHostId }
  }
}

function assertRegisteredRepo(query: RegisteredRepoQuery, store: Store): Repo {
  const result = validateRegisteredRepo(query, store.getRepos())
  if (result.kind === 'denied') {
    throw new Error(result.message)
  }
  return result.repo
}

export function assertRegisteredGitHubRepo(
  args: string | GitHubRepoScopedArgs,
  store: Store
): Repo {
  return assertRegisteredRepo(registeredRepoQuery(args), store)
}

/** A manual PR refresh resolves its twin the way the automatic queue does. */
export function assertRegisteredPRRefreshCandidateRepo(
  candidate: GitHubPRRefreshCandidate,
  store: Store
): Repo {
  return assertRegisteredRepo(prRefreshCandidateQuery(candidate), store)
}

/** Pure: a project is still registered at the candidate's path on its execution host (the queue key's identity). */
export function isPRRefreshCandidateRegistered(
  candidate: GitHubPRRefreshCandidate,
  repos: readonly Repo[]
): boolean {
  const repoPath = resolve(candidate.repoPath)
  const hostId = getRepoExecutionHostId(candidate)
  return repos.some(
    (repo) => resolve(repo.path) === repoPath && getRepoExecutionHostId(repo) === hostId
  )
}

export function getGitHubRepoConnectionId(repo: Repo): string | null {
  return repo.connectionId ?? null
}

export function getGitHubLocalGitOptionArgs(
  store: Store,
  repo: Repo
): [] | [LocalProjectGhExecOptions] {
  const localGitOptions = getLocalProjectGhExecOptions(store, repo)
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
  const result = validateRegisteredRepo(prRefreshCandidateQuery(candidate), repos)
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
