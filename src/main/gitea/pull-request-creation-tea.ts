import type { CreateHostedReviewResult } from '../../shared/hosted-review'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { HostedReviewApiRequestError } from '../source-control/hosted-review-api-request'
import { getGiteaPullRequestForBranch, invalidateGiteaPullRequestScanForRepo } from './client'
import { runGiteaTeaCommand } from './pull-request-mutation-transport'
import {
  getGiteaRepoRef,
  teaRepoArgs,
  type GiteaRepoRef,
  type LocalGitExecOptions
} from './repository-ref'

const CREATE_REQUEST_TIMEOUT_MS = 60_000

function apiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function classifyGiteaCreateError(error: unknown): CreateHostedReviewResult {
  const message = apiErrorMessage(error)
  if (message) {
    console.warn('createGiteaPullRequest failed:', message)
  }
  const lower = message.toLowerCase()
  const status = error instanceof HostedReviewApiRequestError ? error.status : null
  if (
    status === 401 ||
    status === 403 ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden') ||
    lower.includes('authentication')
  ) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Gitea is not authenticated. Next step: set ORCA_GITEA_TOKEN in this environment.',
      reason: 'auth_required'
    }
  }
  if (status === 409 || lower.includes('already exists') || lower.includes('already open')) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
      reason: 'existing_review'
    }
  }
  if (
    (error instanceof HostedReviewApiRequestError && error.timedOut) ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  ) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'PR creation may have completed. Refreshing branch review state...',
      reason: 'creation_unconfirmed'
    }
  }
  if (status === 400 || status === 422 || lower.includes('validation')) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: Gitea rejected the pull request. Check the base branch and branch state, then try again.',
      reason: 'rejected'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create PR failed: Gitea could not create the pull request. Try again in a moment.',
    reason: 'create_failed'
  }
}

function parseTeaCreatedPull(stdout: string): { number: number; url: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  if (!('index' in parsed) || !('url' in parsed)) {
    return null
  }
  const index = parsed.index
  const url = parsed.url
  if (typeof index !== 'number' || !Number.isInteger(index) || index <= 0) {
    return null
  }
  if (typeof url !== 'string' || url.trim().length === 0) {
    return null
  }
  return { number: index, url }
}

export async function findExistingGiteaPullRequest(
  repoPath: string,
  head: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  options: HostedReviewExecutionOptions = {}
): Promise<{ number: number; url: string } | null> {
  // A create attempt may already have mutated the remote; discard pre-POST listings.
  const repo = await getGiteaRepoRef(repoPath, connectionId, localGitOptions)
  if (repo) {
    invalidateGiteaPullRequestScanForRepo(repo)
  }
  const existing = await getGiteaPullRequestForBranch(repoPath, head, null, connectionId, options)
  return existing ? { number: existing.number, url: existing.url } : null
}

export async function finishUnconfirmedGiteaCreate(
  classified: CreateHostedReviewResult,
  repoPath: string,
  head: string,
  connectionId: string | null,
  localGitOptions: LocalGitExecOptions,
  options: HostedReviewExecutionOptions
): Promise<CreateHostedReviewResult> {
  if (
    !classified.ok &&
    (classified.code === 'already_exists' || classified.code === 'unknown_completion')
  ) {
    const existing = await findExistingGiteaPullRequest(
      repoPath,
      head,
      connectionId,
      localGitOptions,
      options
    ).catch(() => null)
    if (existing) {
      return {
        ok: false,
        code: 'already_exists',
        error: 'A pull request already exists for this branch.',
        reason: 'existing_review',
        existingReview: existing
      }
    }
  }
  return classified
}

export async function createGiteaPullRequestWithTea(
  repoPath: string,
  repo: GiteaRepoRef,
  input: { base: string; head: string; title: string; body: string; draft: boolean },
  connectionId: string | null,
  localGitOptions: LocalGitExecOptions,
  options: HostedReviewExecutionOptions
): Promise<CreateHostedReviewResult> {
  const args = [
    'pr',
    'create',
    ...teaRepoArgs(repo),
    '--base',
    input.base,
    '--head',
    input.head,
    '--title',
    input.title,
    '--description',
    input.body,
    ...(input.draft ? ['--draft'] : []),
    '-o',
    'json'
  ]
  const created = await runGiteaTeaCommand(
    args,
    localGitOptions,
    repoPath,
    CREATE_REQUEST_TIMEOUT_MS
  )
  if (!created.ok) {
    return finishUnconfirmedGiteaCreate(
      classifyGiteaCreateError(new Error(created.error)),
      repoPath,
      input.head,
      connectionId,
      localGitOptions,
      options
    )
  }
  const parsed = parseTeaCreatedPull(created.stdout)
  if (parsed) {
    invalidateGiteaPullRequestScanForRepo(repo)
    return { ok: true, number: parsed.number, url: parsed.url }
  }
  const found = await findExistingGiteaPullRequest(
    repoPath,
    input.head,
    connectionId,
    localGitOptions,
    options
  ).catch(() => null)
  return found
    ? { ok: true, ...found }
    : {
        ok: false,
        code: 'unknown_completion',
        error: 'PR creation may have completed. Refreshing branch review state...',
        reason: 'creation_unconfirmed'
      }
}
