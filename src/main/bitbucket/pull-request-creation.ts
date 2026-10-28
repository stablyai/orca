import type { ExecutionHostId } from '../../shared/execution-host'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
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
import { authHeaders, getEnvAuthConfig, hasAuth } from './bitbucket-auth-config'
import { resolveBitbucketAuthConfig } from './resolve-auth'
import { hasStoredBitbucketCredential } from './credential-store'
import { getBitbucketPullRequestForBranch } from './client'
import { mapBitbucketPullRequest, type RawBitbucketPullRequest } from './pull-request-mappers'
import { getBitbucketRepoRef, type BitbucketRepoRef } from './repository-ref'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { getHostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'

const CREATE_REQUEST_TIMEOUT_MS = 60_000

// Sidebar eligibility must avoid keychain prompts; creation validates the actual credential.
export function isBitbucketReviewCreationAuthenticated(): boolean {
  return hasAuth(getEnvAuthConfig()) || hasStoredBitbucketCredential()
}

function encodedRepoPath(repo: BitbucketRepoRef): string {
  return `${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}`
}

function apiErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function classifyCreateError(error: unknown): CreateHostedReviewResult {
  const message = apiErrorMessage(error)
  if (message) {
    console.warn('createBitbucketPullRequest failed:', message)
  }
  const lower = message.toLowerCase()
  const status = error instanceof HostedReviewApiRequestError ? error.status : null
  if (status === 401 || status === 403 || lower.includes('unauthorized')) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Bitbucket is not authenticated. Next step: connect Bitbucket in Settings > Integrations, or set ORCA_BITBUCKET_* in this environment.',
      reason: 'auth_required'
    }
  }
  // Duplicate branches return HTTP 400, so inspect the message.
  if (lower.includes('already exists') || lower.includes('already a pull request')) {
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
  if (status === 400 || status === 422) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: Bitbucket rejected the pull request. Check the base branch and branch state, then try again.',
      reason: 'rejected'
    }
  }
  if (status === 404) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: Bitbucket could not find the repository. Check that the credential has write access to it.',
      reason: 'repository_not_found'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create PR failed: Bitbucket could not create the pull request. Try again in a moment.',
    reason: 'create_failed'
  }
}

async function findExistingPullRequest(
  repoPath: string,
  head: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<{ number: number; url: string } | null> {
  const existing = await getBitbucketPullRequestForBranch(
    repoPath,
    head,
    null,
    connectionId,
    options
  )
  return existing ? { number: existing.number, url: existing.url } : null
}

export async function createBitbucketPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
  if (input.provider !== 'bitbucket') {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating reviews for this provider is not supported yet.',
      reason: 'provider_not_supported'
    }
  }

  // The Bitbucket REST calls run on this client; only the git reads under them are routed.
  const connectionId = hostedReviewSshConnectionId(executionHostId)

  const config = resolveBitbucketAuthConfig()
  if (!hasAuth(config)) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Bitbucket is not connected. Next step: connect Bitbucket in Settings > Integrations.',
      reason: 'auth_required'
    }
  }

  const repo = await getBitbucketRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a Bitbucket remote.',
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
      error: 'Create PR failed: base branch, head branch, and title are required.'
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
  // Ignore saved draft defaults because Bitbucket's composer has no control to clear them.
  const description =
    input.useTemplate && !input.body?.trim()
      ? await readHostedPullRequestTemplate(repoPath, connectionId)
      : (input.body ?? '')
  const requestBody = {
    title,
    description,
    source: { branch: { name: head } },
    destination: { branch: { name: base } }
  }

  try {
    const raw = await requestHostedReviewJson<RawBitbucketPullRequest>(
      new URL(
        `${config.baseUrl.replace(/\/+$/, '')}/repositories/${encodedRepoPath(repo)}/pullrequests`
      ),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...authHeaders(config)
        },
        body: JSON.stringify(requestBody)
      },
      CREATE_REQUEST_TIMEOUT_MS
    )
    const created = mapBitbucketPullRequest(raw, 'neutral')
    if (created) {
      return { ok: true, number: created.number, url: created.url }
    }
    const found = await findExistingPullRequest(repoPath, head, connectionId, options).catch(
      () => null
    )
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
      const existing = await findExistingPullRequest(repoPath, head, connectionId, options).catch(
        () => null
      )
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
