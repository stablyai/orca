import type { ExecutionHostId } from '../../shared/execution-host'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import type { BitbucketPRMergeMethod } from '../../shared/bitbucket-merge-methods'
import {
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import { authHeaders, hasAuth } from './bitbucket-auth-config'
import { resolveBitbucketAuthConfig } from './resolve-auth'
import { getBitbucketRepoRef, type BitbucketRepoRef } from './repository-ref'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { getHostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'
import { invalidateHostedReviewBranchCache } from '../source-control/hosted-review-branch-cache'

const MERGE_REQUEST_TIMEOUT_MS = 60_000

export type BitbucketMergeResult = { ok: true } | { ok: false; error: string }

function encodedRepoPath(repo: BitbucketRepoRef): string {
  return `${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}`
}

function apiErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    try {
      const parsed = JSON.parse(error.message) as {
        error?: { message?: string; detail?: string }
        message?: string
      }
      if (parsed?.error?.message) {
        return parsed.error.detail
          ? `${parsed.error.message}: ${parsed.error.detail}`
          : parsed.error.message
      }
      if (parsed?.message) {
        return parsed.message
      }
    } catch {
      // not JSON
    }
    return error.message
  }
  return String(error)
}

function classifyMergeError(error: unknown, method: BitbucketPRMergeMethod): BitbucketMergeResult {
  const message = apiErrorMessage(error)
  const lower = message.toLowerCase()
  const status = error instanceof HostedReviewApiRequestError ? error.status : null

  if (status === 401 || status === 403 || lower.includes('unauthorized')) {
    return {
      ok: false,
      error: 'Merge failed: permission denied. Check your Bitbucket account permissions.'
    }
  }

  if (
    method === 'fast_forward' &&
    (lower.includes('fast forward') || lower.includes('fast-forward'))
  ) {
    return {
      ok: false,
      error:
        'Fast-forward merge not possible: the target branch has new commits. Rebase your branch or use merge commit.'
    }
  }

  if (lower.includes('conflict') || lower.includes('merge conflict')) {
    return {
      ok: false,
      error: 'Merge failed: this pull request has merge conflicts that must be resolved first.'
    }
  }

  if (status === 404) {
    return {
      ok: false,
      error: 'Merge failed: pull request or repository not found.'
    }
  }

  if (status === 409 || lower.includes('already merged') || lower.includes('not open')) {
    return {
      ok: false,
      error: 'Merge failed: this pull request is no longer open.'
    }
  }

  return {
    ok: false,
    error: message
      ? `Merge failed: ${message}`
      : 'Merge failed: Bitbucket could not complete the request.'
  }
}

export async function mergeBitbucketPullRequest(
  repoPath: string,
  prNumber: number,
  method: BitbucketPRMergeMethod = 'merge_commit',
  closeSourceBranch = false,
  executionHostId: ExecutionHostId = 'local',
  options: HostedReviewExecutionOptions = {}
): Promise<BitbucketMergeResult> {
  let connectionId: string | null
  try {
    connectionId = hostedReviewSshConnectionId(executionHostId)
  } catch (error) {
    return {
      ok: false,
      error: `Merge failed: ${error instanceof Error ? error.message : 'Invalid execution host.'}`
    }
  }
  const config = resolveBitbucketAuthConfig()

  if (!hasAuth(config)) {
    return {
      ok: false,
      error:
        'Merge failed: Bitbucket is not connected. Connect Bitbucket in Settings > Integrations.'
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
      error: 'Merging pull requests requires a Bitbucket remote.'
    }
  }

  let url: URL
  try {
    url = new URL(
      `${config.baseUrl.replace(/\/+$/, '')}/repositories/${encodedRepoPath(repo)}/pullrequests/${prNumber}/merge`
    )
  } catch {
    return {
      ok: false,
      error: 'Merge failed: Bitbucket API URL must use HTTPS.'
    }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Merge failed: Bitbucket API URL must use HTTPS.'
    }
  }

  const body = {
    merge_strategy: method,
    close_source_branch: closeSourceBranch
  }

  try {
    await requestHostedReviewJson(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...authHeaders(config)
        },
        body: JSON.stringify(body)
      },
      MERGE_REQUEST_TIMEOUT_MS
    )
    invalidateHostedReviewBranchCache(repoPath, executionHostId)
    return { ok: true }
  } catch (error) {
    return classifyMergeError(error, method)
  }
}

export async function declineBitbucketPullRequest(
  repoPath: string,
  prNumber: number,
  executionHostId: ExecutionHostId = 'local',
  options: HostedReviewExecutionOptions = {}
): Promise<BitbucketMergeResult> {
  let connectionId: string | null
  try {
    connectionId = hostedReviewSshConnectionId(executionHostId)
  } catch (error) {
    return {
      ok: false,
      error: `Close failed: ${error instanceof Error ? error.message : 'Invalid execution host.'}`
    }
  }
  const config = resolveBitbucketAuthConfig()

  if (!hasAuth(config)) {
    return {
      ok: false,
      error:
        'Close failed: Bitbucket is not connected. Connect Bitbucket in Settings > Integrations.'
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
      error: 'Closing pull requests requires a Bitbucket remote.'
    }
  }

  let url: URL
  try {
    url = new URL(
      `${config.baseUrl.replace(/\/+$/, '')}/repositories/${encodedRepoPath(repo)}/pullrequests/${prNumber}/decline`
    )
  } catch {
    return {
      ok: false,
      error: 'Close failed: Bitbucket API URL must use HTTPS.'
    }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Close failed: Bitbucket API URL must use HTTPS.'
    }
  }

  try {
    await requestHostedReviewJson(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          ...authHeaders(config)
        }
      },
      MERGE_REQUEST_TIMEOUT_MS
    )
    invalidateHostedReviewBranchCache(repoPath, executionHostId)
    return { ok: true }
  } catch (error) {
    const message = apiErrorMessage(error)
    return {
      ok: false,
      error: message
        ? `Close failed: ${message}`
        : 'Close failed: Bitbucket could not complete the request.'
    }
  }
}
