import type { CreateHostedReviewInput, CreateHostedReviewResult } from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import {
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import { readHostedPullRequestTemplate } from '../source-control/pull-request-template'
import { getGiteaPullRequestForBranch } from './client'
import { mapGiteaPullRequest, type RawGiteaPullRequest } from './pull-request-mappers'
import { getGiteaRepoRef, type GiteaRepoRef } from './repository-ref'

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

export function isGiteaReviewCreationAuthenticated(): boolean {
  return envValue('ORCA_GITEA_TOKEN') !== null
}

function authHeaders(): Record<string, string> {
  const token = envValue('ORCA_GITEA_TOKEN')
  return token ? { Authorization: `token ${token}` } : {}
}

function apiUrl(repo: GiteaRepoRef, path: string): URL {
  return new URL(`${configuredApiBaseUrl(repo).replace(/\/+$/, '')}${path}`)
}

function encodedRepoPath(repo: GiteaRepoRef): string {
  return `${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`
}

function apiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyCreateError(error: unknown): CreateHostedReviewResult {
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
        'Create PR failed: Gitea is not authenticated. Next step: set ORCA_GITEA_TOKEN in this environment.'
    }
  }
  if (status === 409 || lower.includes('already exists') || lower.includes('already open')) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.'
    }
  }
  if (error instanceof HostedReviewApiRequestError && error.timedOut) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'PR creation may have completed. Refreshing branch review state...'
    }
  }
  if (status === 400 || status === 422 || lower.includes('validation')) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: Gitea rejected the pull request. Check the base branch and branch state, then try again.'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create PR failed: Gitea could not create the pull request. Try again in a moment.'
  }
}

async function findExistingPullRequest(
  repoPath: string,
  head: string,
  connectionId?: string | null
): Promise<{ number: number; url: string } | null> {
  const existing = await getGiteaPullRequestForBranch(repoPath, head, null, connectionId)
  return existing ? { number: existing.number, url: existing.url } : null
}

export async function createGiteaPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  connectionId?: string | null
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'gitea') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }

  const repo = await getGiteaRepoRef(repoPath, connectionId)
  if (!repo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a Gitea remote.'
    }
  }

  const base = normalizeHostedReviewBaseRef(input.base)
  const head = input.head ? normalizeHostedReviewHeadRef(input.head) : ''
  const title = input.title.trim()
  if (!base || !head || !title) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: base branch, head branch, and title are required.'
    }
  }
  if (head.toLowerCase() === base.toLowerCase()) {
    return {
      ok: false,
      code: 'validation',
      error: 'Create PR failed: choose a different base branch before creating a pull request.'
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
      return { ok: true, number: created.number, url: created.url }
    }
    const found = await findExistingPullRequest(repoPath, head, connectionId).catch(() => null)
    return found
      ? { ok: true, ...found }
      : {
          ok: false,
          code: 'unknown_completion',
          error: 'PR creation may have completed. Refreshing branch review state...'
        }
  } catch (error) {
    const classified = classifyCreateError(error)
    if (
      !classified.ok &&
      (classified.code === 'already_exists' || classified.code === 'unknown_completion')
    ) {
      const existing = await findExistingPullRequest(repoPath, head, connectionId).catch(() => null)
      if (existing) {
        return {
          ok: false,
          code: 'already_exists',
          error: 'A pull request already exists for this branch.',
          existingReview: existing
        }
      }
    }
    return classified
  }
}
