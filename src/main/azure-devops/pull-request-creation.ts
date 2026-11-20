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
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import { readHostedPullRequestTemplate } from '../source-control/pull-request-template'
import {
  AZURE_DEVOPS_MAX_REQUEST_ATTEMPTS,
  assertAzureDevOpsCliEndpoint,
  azureDevOpsApiVersionForOrigin,
  recordAzureDevOpsApiVersionRejection,
  resolveAzureDevOpsGitApiBaseUrl
} from './azure-devops-api-request'
import {
  assertAzureDevOpsCredentialsCurrent,
  getAzureDevOpsAuthMethod,
  invalidateAzureDevOpsCredentials,
  resolveAzureDevOpsCredentials
} from './azure-devops-credentials'
import { AzureDevOpsAuthError } from './azure-cli-access-token'
import { getAzureDevOpsPullRequestForBranch } from './client'
import { mapAzureDevOpsPullRequest, type RawAzureDevOpsPullRequest } from './pull-request-mappers'
import { getAzureDevOpsRepoRef, type AzureDevOpsRepoRef } from './repository-ref'

const CREATE_REQUEST_TIMEOUT_MS = 60_000

function apiUrl(baseUrl: string, path: string): URL {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`)
  url.searchParams.set('api-version', azureDevOpsApiVersionForOrigin(url.origin))
  return url
}

// Version rejections precede PR creation, so retrying them is safe.
async function requestCreatePullRequest(
  repo: AzureDevOpsRepoRef,
  path: string,
  init: Omit<RequestInit, 'signal'>
): Promise<RawAzureDevOpsPullRequest> {
  const baseUrl = resolveAzureDevOpsGitApiBaseUrl(repo)
  if (getAzureDevOpsAuthMethod() === 'azure-cli') {
    assertAzureDevOpsCliEndpoint(baseUrl)
  }
  const credentials = await resolveAzureDevOpsCredentials()
  const cli = credentials.method === 'azure-cli' ? credentials : null
  for (let attempt = 1; ; attempt++) {
    const url = apiUrl(baseUrl, path)
    assertAzureDevOpsCredentialsCurrent(credentials)
    if (cli) {
      assertAzureDevOpsCliEndpoint(url)
    }
    try {
      const headers = new Headers(init.headers)
      for (const [name, value] of Object.entries(credentials.headers)) {
        headers.set(name, value)
      }
      return await requestHostedReviewJson<RawAzureDevOpsPullRequest>(
        url,
        {
          ...init,
          headers,
          ...(cli ? { redirect: 'error' } : {})
        },
        CREATE_REQUEST_TIMEOUT_MS
      )
    } catch (error) {
      if (cli && error instanceof HostedReviewApiRequestError) {
        if (error.status === 401) {
          invalidateAzureDevOpsCredentials({ generation: cli.generation })
          throw new AzureDevOpsAuthError('unauthorized')
        }
        if (error.status === 403) {
          throw new AzureDevOpsAuthError('forbidden')
        }
      }
      if (
        attempt >= AZURE_DEVOPS_MAX_REQUEST_ATTEMPTS ||
        !(error instanceof HostedReviewApiRequestError) ||
        !recordAzureDevOpsApiVersionRejection(url, error.status, error.message)
      ) {
        throw error
      }
    }
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
  if (error instanceof AzureDevOpsAuthError) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        error.code === 'unsupported-endpoint'
          ? 'Create PR failed: Azure CLI authentication requires Azure DevOps Services.'
          : error.code === 'forbidden'
            ? 'Create PR failed: the Azure CLI account does not have permission to create this pull request.'
            : 'Create PR failed: check your Azure CLI sign-in and select Re-check in Settings > Integrations.',
      reason: 'auth_required'
    }
  }
  const message = apiErrorMessage(error)
  if (message) {
    const status = error instanceof HostedReviewApiRequestError ? error.status : null
    console.warn('createAzureDevOpsPullRequest failed:', status ?? 'request failed')
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
        getAzureDevOpsAuthMethod() === 'azure-cli'
          ? 'Create PR failed: check your Azure CLI sign-in and select Re-check in Settings > Integrations.'
          : 'Create PR failed: Azure DevOps is not authenticated. Next step: set ORCA_AZURE_DEVOPS_TOKEN in this environment.',
      reason: 'auth_required'
    }
  }
  if (status === 409 || lower.includes('already exists') || lower.includes('active pull request')) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A pull request already exists for this branch.',
      reason: 'existing_review'
    }
  }
  if (error instanceof HostedReviewApiRequestError && error.timedOut) {
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
        'Create PR failed: Azure DevOps rejected the pull request. Check the base branch and branch state, then try again.',
      reason: 'rejected'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error:
      'Create PR failed: Azure DevOps could not create the pull request. Try again in a moment.',
    reason: 'create_failed'
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
  executionHostId: ExecutionHostId
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'azure-devops') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.',
      reason: 'provider_not_supported'
    }
  }

  // The Azure DevOps REST calls run on this client; only the git reads under them are routed.
  const connectionId = hostedReviewSshConnectionId(executionHostId)

  const repo = await getAzureDevOpsRepoRef(repoPath, connectionId)
  if (!repo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires an Azure DevOps remote.',
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
    sourceRefName: azureBranchRef(head),
    targetRefName: azureBranchRef(base),
    title,
    description: body,
    ...(input.draft ? { isDraft: true } : {})
  }

  try {
    const raw = await requestCreatePullRequest(
      repo,
      `/_apis/git/repositories/${encodePathSegment(repo.repository)}/pullRequests`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
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
          error: 'PR creation may have completed. Refreshing branch review state...',
          reason: 'creation_unconfirmed'
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
          reason: 'existing_review',
          existingReview: existing
        }
      }
    }
    return classified
  }
}
