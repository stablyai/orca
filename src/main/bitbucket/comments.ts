import type { PRComment } from '../../shared/github/comment-types'
import type { HostedReviewExecutionOptions } from '../source-control/hosted-review-git-options'
import { getHostedReviewLocalGitOptions } from '../source-control/hosted-review-git-options'
import { requestHostedReviewJson } from '../source-control/hosted-review-api-request'
import { authHeaders, hasAuth } from './bitbucket-auth-config'
import { resolveBitbucketAuthConfig } from './resolve-auth'
import { getBitbucketRepoRef, type BitbucketRepoRef } from './repository-ref'

const REQUEST_TIMEOUT_MS = 30_000

import {
  apiErrorMessage,
  mapBitbucketComment,
  mapBitbucketComments,
  type RawBitbucketComment
} from './comments-mappers'

export { apiErrorMessage, mapBitbucketComment, mapBitbucketComments, type RawBitbucketComment }

export class BitbucketInsecureUrlError extends Error {
  constructor(message = 'Bitbucket API URL must use HTTPS.') {
    super(message)
    this.name = 'BitbucketInsecureUrlError'
  }
}

function encodedRepoPath(repo: BitbucketRepoRef): string {
  return `${encodeURIComponent(repo.workspace)}/${encodeURIComponent(repo.repoSlug)}`
}

export async function fetchBitbucketPRComments(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<PRComment[]> {
  const config = resolveBitbucketAuthConfig()
  if (!hasAuth(config)) {
    return []
  }

  const repo = await getBitbucketRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return []
  }

  const base = config.baseUrl.replace(/\/+$/, '')
  let initialUrl: URL
  try {
    initialUrl = new URL(
      `${base}/repositories/${encodedRepoPath(repo)}/pullrequests/${prNumber}/comments`
    )
  } catch {
    return []
  }
  initialUrl.searchParams.set('pagelen', '100')
  initialUrl.searchParams.set('fields', '+values.resolution')

  if (initialUrl.protocol !== 'https:') {
    throw new BitbucketInsecureUrlError()
  }

  const allowedOrigin = new URL(base).origin
  const rawComments: RawBitbucketComment[] = []
  let nextUrl: string | null = initialUrl.toString()
  let pageCount = 0
  const MAX_PAGES = 10

  try {
    while (nextUrl && pageCount < MAX_PAGES) {
      pageCount++
      const targetUrl = new URL(nextUrl)
      if (targetUrl.protocol !== 'https:') {
        throw new BitbucketInsecureUrlError()
      }
      if (targetUrl.origin !== allowedOrigin) {
        console.warn('Ignoring Bitbucket pagination URL with unexpected origin')
        break
      }
      const pageData = await requestHostedReviewJson<{
        values?: RawBitbucketComment[]
        next?: string
      }>(
        targetUrl,
        {
          method: 'GET',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            ...authHeaders(config)
          }
        },
        REQUEST_TIMEOUT_MS
      )
      if (Array.isArray(pageData.values)) {
        rawComments.push(...pageData.values)
      }
      nextUrl = typeof pageData.next === 'string' && pageData.next ? pageData.next : null
    }
    return mapBitbucketComments(rawComments)
  } catch (err) {
    if (err instanceof BitbucketInsecureUrlError) {
      throw err
    }
    console.warn('Failed to fetch Bitbucket PR comments:', err)
    return []
  }
}

export async function addBitbucketPRComment(
  repoPath: string,
  prNumber: number,
  body: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  inline?: { path: string; line: number }
): Promise<{ ok: true; comment: PRComment } | { ok: false; error: string }> {
  const config = resolveBitbucketAuthConfig()
  if (!hasAuth(config)) {
    return {
      ok: false,
      error:
        'Commenting failed: Bitbucket is not connected. Connect Bitbucket in Settings > Integrations.'
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
      error: 'Commenting requires a Bitbucket remote.'
    }
  }

  const base = config.baseUrl.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(`${base}/repositories/${encodedRepoPath(repo)}/pullrequests/${prNumber}/comments`)
  } catch {
    return {
      ok: false,
      error: 'Bitbucket API URL must use HTTPS.'
    }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Bitbucket API URL must use HTTPS.'
    }
  }

  const payload: Record<string, unknown> = {
    content: {
      raw: body
    }
  }
  if (inline) {
    payload.inline = {
      path: inline.path,
      to: inline.line
    }
  }

  try {
    const created = await requestHostedReviewJson<RawBitbucketComment>(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...authHeaders(config)
        },
        body: JSON.stringify(payload)
      },
      REQUEST_TIMEOUT_MS
    )
    return {
      ok: true,
      comment: mapBitbucketComment(created)
    }
  } catch (error) {
    const message = apiErrorMessage(error)
    return {
      ok: false,
      error: message ? `Failed to add comment: ${message}` : 'Failed to add comment.'
    }
  }
}

export async function replyBitbucketPRComment(
  repoPath: string,
  prNumber: number,
  parentCommentId: number,
  body: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  rootCommentId?: number
): Promise<{ ok: true; comment: PRComment } | { ok: false; error: string }> {
  const config = resolveBitbucketAuthConfig()
  if (!hasAuth(config)) {
    return {
      ok: false,
      error:
        'Commenting failed: Bitbucket is not connected. Connect Bitbucket in Settings > Integrations.'
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
      error: 'Commenting requires a Bitbucket remote.'
    }
  }

  const base = config.baseUrl.replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(`${base}/repositories/${encodedRepoPath(repo)}/pullrequests/${prNumber}/comments`)
  } catch {
    return {
      ok: false,
      error: 'Bitbucket API URL must use HTTPS.'
    }
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      error: 'Bitbucket API URL must use HTTPS.'
    }
  }

  try {
    const created = await requestHostedReviewJson<RawBitbucketComment>(
      url,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...authHeaders(config)
        },
        body: JSON.stringify({
          content: {
            raw: body
          },
          parent: {
            id: parentCommentId
          }
        })
      },
      REQUEST_TIMEOUT_MS
    )
    return {
      ok: true,
      comment: mapBitbucketComment(created, rootCommentId ?? parentCommentId)
    }
  } catch (error) {
    const message = apiErrorMessage(error)
    return {
      ok: false,
      error: message ? `Failed to reply to comment: ${message}` : 'Failed to reply to comment.'
    }
  }
}
