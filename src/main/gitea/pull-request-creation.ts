import type { ExecutionHostId } from '../../shared/execution-host/execution-host'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import type {
  CreateHostedReviewInput,
  CreateHostedReviewResult
} from '../../shared/source-control/hosted-review/hosted-review-contracts'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/source-control/hosted-review/hosted-review-refs'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { requestHostedReviewJson } from '../source-control/hosted-review-api-request'
import { classifyGiteaCreateError, parseGtCreatedPull } from './pull-request-create-result'
import { readHostedPullRequestTemplate } from '../source-control/pull-request-template'
import { getGiteaPullRequestForBranch, invalidateGiteaPullRequestScanForRepo } from './client'
import { mapGiteaPullRequest, type RawGiteaPullRequest } from './pull-request-mappers'
import {
  directGiteaApiToken,
  giteaWriteUsesGt,
  runGiteaGtCommand
} from './pull-request-mutation-transport'
import {
  getGiteaRepoRef,
  gtRepoArgs,
  type GiteaRepoRef,
  type LocalGitExecOptions
} from './repository-ref'

const CREATE_REQUEST_TIMEOUT_MS = 60_000

function envValue(name: string): string | null {
  const value = process.env[name]?.trim() ?? ''
  return value.length > 0 ? value : null
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return /\/api\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/api/v1`
}

function configuredApiBaseUrl(repo: GiteaRepoRef): string {
  const configured = envValue('ORCA_GITEA_API_BASE_URL')
  return configured ? normalizeApiBaseUrl(configured) : repo.apiBaseUrl
}

export function isGiteaReviewCreationAuthenticated(
  repoPath?: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<boolean> | boolean {
  if (directGiteaApiToken()) {
    return true
  }
  if (!repoPath) {
    return false
  }
  return getGiteaRepoRef(repoPath, connectionId, getHostedReviewLocalGitOptions(options)).then(
    (repo) => Boolean(repo?.loginName)
  )
}

function authHeaders(): Record<string, string> {
  const token = directGiteaApiToken()
  return token ? { Authorization: `token ${token}` } : {}
}

function apiUrl(repo: GiteaRepoRef, path: string): URL {
  return new URL(`${configuredApiBaseUrl(repo).replace(/\/+$/, '')}${path}`)
}

function encodedRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

export async function findExistingGiteaPullRequest(
  repoPath: string,
  head: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  options: HostedReviewExecutionOptions = {}
): Promise<{ number: number; url: string } | null> {
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

async function createGiteaPullRequestWithGt(
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
    ...gtRepoArgs(repo),
    '--base',
    input.base,
    '--head',
    input.head,
    '--title',
    input.title,
    '--body',
    input.body,
    ...(input.draft ? ['--draft'] : []),
    '--yes',
    '--json',
    'number,url'
  ]
  const created = await runGiteaGtCommand(
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
  const parsed = parseGtCreatedPull(created.stdout)
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

export async function createGiteaPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'gitea') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.',
      reason: 'provider_not_supported'
    }
  }

  const connectionId = hostedReviewSshConnectionId(executionHostId)
  const localGitOptions = getHostedReviewLocalGitOptions(options)

  const repo = await getGiteaRepoRef(repoPath, connectionId, localGitOptions)
  if (!repo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a Gitea remote.',
      reason: 'unsupported_provider'
    }
  }

  const base = normalizeHostedReviewBaseRef(input.base)
  const head = input.head ? normalizeHostedReviewHeadRef(input.head) : ''
  const title = input.title.trim()
  if (!base || !head || !title) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: base branch, head branch, and title are required.',
      reason: 'base_head_title_required'
    }
  }
  if (head.toLowerCase() === base.toLowerCase()) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: choose a different base branch before creating a pull request.',
      reason: 'same_base_branch'
    }
  }

  const body =
    input.useTemplate && !input.body?.trim()
      ? await readHostedPullRequestTemplate(repoPath, connectionId)
      : (input.body ?? '')
  const requestBody = {
    base,
    head,
    title,
    body,
    ...(input.draft ? { draft: true } : {})
  }

  if (!directGiteaApiToken() && !repo.loginName) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Gitea is not authenticated. Next step: set ORCA_GITEA_TOKEN or run gt auth login in this environment.',
      reason: 'auth_required'
    }
  }

  if (giteaWriteUsesGt(repo)) {
    return createGiteaPullRequestWithGt(
      repoPath,
      repo,
      { base, head, title, body, draft: input.draft === true },
      connectionId,
      localGitOptions,
      options
    )
  }

  try {
    const raw = await requestHostedReviewJson<RawGiteaPullRequest>(
      apiUrl(repo, `/repos/${encodedRepoPath(repo)}/pulls`),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...authHeaders()
        },
        body: JSON.stringify(requestBody)
      },
      CREATE_REQUEST_TIMEOUT_MS
    )
    const created = mapGiteaPullRequest(raw, 'neutral')
    if (created) {
      invalidateGiteaPullRequestScanForRepo(repo)
      return { ok: true, number: created.number, url: created.url }
    }
    const found = await findExistingGiteaPullRequest(
      repoPath,
      head,
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
  } catch (error) {
    return finishUnconfirmedGiteaCreate(
      classifyGiteaCreateError(error),
      repoPath,
      head,
      connectionId,
      localGitOptions,
      options
    )
  }
}
