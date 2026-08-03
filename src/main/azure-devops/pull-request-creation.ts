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
import {
  getAzCliAzureDevOpsAccessToken,
  isEntraEligibleAzureDevOpsBaseUrl
} from './az-cli-access-token'
import {
  azureDevOpsApiVersionForOrigin,
  azureDevOpsTokenConfigured,
  getAzureDevOpsAuthConfig,
  isAzureDevOpsPreviewVersionRejection,
  markAzureDevOpsPreviewApiVersionOrigin,
  normalizeAzureDevOpsApiBaseUrl,
  resolveAzureDevOpsAuthHeaders,
  resolveAzureDevOpsGitApiBaseUrl
} from './azure-devops-api-request'
import { getAzureDevOpsPullRequestForBranch } from './client'
import { mapAzureDevOpsPullRequest, type RawAzureDevOpsPullRequest } from './pull-request-mappers'
import { getAzureDevOpsRepoRef, type AzureDevOpsRepoRef } from './repository-ref'

const CREATE_REQUEST_TIMEOUT_MS = 60_000

/**
 * A configured env token always authenticates. Otherwise hosted Azure DevOps
 * accepts the az CLI's Entra login; on-prem servers require the token.
 */
export async function isAzureDevOpsReviewCreationAuthenticated(
  repoPath: string,
  connectionId?: string | null
): Promise<boolean> {
  const config = getAzureDevOpsAuthConfig()
  if (azureDevOpsTokenConfigured(config)) {
    return true
  }
  const baseUrl = config.apiBaseUrl
    ? normalizeAzureDevOpsApiBaseUrl(config.apiBaseUrl)
    : (await getAzureDevOpsRepoRef(repoPath, connectionId))?.apiBaseUrl
  if (!baseUrl || !isEntraEligibleAzureDevOpsBaseUrl(baseUrl)) {
    return false
  }
  return (await getAzCliAzureDevOpsAccessToken()) !== null
}

function apiUrl(repo: AzureDevOpsRepoRef, path: string): URL {
  const baseUrl = resolveAzureDevOpsGitApiBaseUrl(repo)
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  url.searchParams.set('api-version', azureDevOpsApiVersionForOrigin(url.origin))
  return url
}

// Why (STA-3494): Azure DevOps Server 400s versioned requests without -preview;
// the rejection happens before the PR is created, so one retry is safe.
async function requestCreatePullRequest(
  repo: AzureDevOpsRepoRef,
  path: string,
  init: Omit<RequestInit, 'signal'>
): Promise<RawAzureDevOpsPullRequest> {
  const url = apiUrl(repo, path)
  try {
    return await requestHostedReviewJson<RawAzureDevOpsPullRequest>(
      url,
      init,
      CREATE_REQUEST_TIMEOUT_MS
    )
  } catch (error) {
    if (
      url.searchParams.get('api-version')?.endsWith('-preview') ||
      !(error instanceof HostedReviewApiRequestError) ||
      !isAzureDevOpsPreviewVersionRejection(error.status, error.message)
    ) {
      throw error
    }
    markAzureDevOpsPreviewApiVersionOrigin(url.origin)
    return requestHostedReviewJson<RawAzureDevOpsPullRequest>(
      apiUrl(repo, path),
      init,
      CREATE_REQUEST_TIMEOUT_MS
    )
  }
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

function azureBranchRef(branch: string): string {
  return `refs/heads/${branch.replace(/^refs\/heads\//, '')}`
}

function apiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyCreateError(error: unknown): CreateHostedReviewResult {
  const message = apiErrorMessage(error)
  if (message) {
    console.warn('createAzureDevOpsPullRequest failed:', message)
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
        'Create PR failed: Azure DevOps is not authenticated. Next step: run az login or set ORCA_AZURE_DEVOPS_TOKEN in this environment.'
    }
  }
  if (status === 409 || lower.includes('already exists') || lower.includes('active pull request')) {
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
        'Create PR failed: Azure DevOps rejected the pull request. Check the base branch and branch state, then try again.'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error:
      'Create PR failed: Azure DevOps could not create the pull request. Try again in a moment.'
  }
}

async function findExistingPullRequest(
  repoPath: string,
  head: string,
  connectionId?: string | null
): Promise<{ number: number; url: string } | null> {
  const existing = await getAzureDevOpsPullRequestForBranch(repoPath, head, null, connectionId)
  return existing ? { number: existing.number, url: existing.url } : null
}

export async function createAzureDevOpsPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  connectionId?: string | null
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'azure-devops') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.'
    }
  }

  const repo = await getAzureDevOpsRepoRef(repoPath, connectionId)
  if (!repo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires an Azure DevOps remote.'
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
    sourceRefName: azureBranchRef(head),
    targetRefName: azureBranchRef(base),
    title,
    description: body,
    ...(input.draft ? { isDraft: true } : {})
  }

  const baseUrl = resolveAzureDevOpsGitApiBaseUrl(repo)
  try {
    const raw = await requestCreatePullRequest(
      repo,
      `/_apis/git/repositories/${encodePathSegment(repo.repository)}/pullRequests`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(await resolveAzureDevOpsAuthHeaders(baseUrl))
        },
        body: JSON.stringify(requestBody)
      }
    )
    const created = mapAzureDevOpsPullRequest(raw, 'neutral', repo.webBaseUrl)
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
