import type {
  CreateHostedReviewResult,
  HostedReviewInfo,
  HostedReviewState
} from '../../shared/hosted-review'
import type { CustomGitServer } from '../../shared/custom-git-server'
import type { MRInfo } from '../../shared/gitlab-types'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import { derivePipelineStatus, mapMRInfo } from '../gitlab/mappers'
import {
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import { readHostedPullRequestTemplate } from '../source-control/pull-request-template'
import type {
  CustomGitServerFlavorClient,
  CustomGitServerRepoRef,
  CustomGitServerVerifyResult
} from './api-flavor-client'

const REQUEST_TIMEOUT_MS = 8000
const CREATE_REQUEST_TIMEOUT_MS = 60_000
const LIST_PER_PAGE = 20

// Raw GitLab v4 merge-request payload — only the fields mapMRInfo /
// derivePipelineStatus read. GitLab-compatible servers (e.g. git.example.com)
// return the same shape, so the GitLab mappers are reused verbatim.
type RawGitLabMergeRequest = {
  iid?: number
  title: string
  state: string
  draft?: boolean
  web_url?: string
  updated_at?: string
  sha?: string
  has_conflicts?: boolean
  detailed_merge_status?: string
  target_branch?: string
  description?: string | null
  author?: { username?: string | null; avatar_url?: string | null } | null
  head_pipeline?: { status?: string } | null
  pipeline?: { status?: string } | null
}

/** Append the GitLab v4 API path to the server's web/API origin. */
function apiBaseUrl(server: CustomGitServer): string {
  const trimmed = server.apiBaseUrl.replace(/\/+$/, '')
  return /\/api\/v4$/i.test(trimmed) ? trimmed : `${trimmed}/api/v4`
}

function authHeaders(token: string | null): Record<string, string> {
  return token ? { 'PRIVATE-TOKEN': token } : {}
}

/** URL-encode the full `namespace/project` path (nested groups included). */
function projectId(ref: CustomGitServerRepoRef): string {
  return encodeURIComponent(`${ref.owner}/${ref.repo}`)
}

function apiUrl(
  server: CustomGitServer,
  path: string,
  searchParams?: Record<string, string | number>
): URL {
  const url = new URL(`${apiBaseUrl(server)}${path}`)
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

/** GET returning null on any non-OK / transport error (status-poll friendly). */
async function requestJson<T>(
  server: CustomGitServer,
  token: string | null,
  path: string,
  searchParams?: Record<string, string | number>
): Promise<T | null> {
  try {
    return await requestHostedReviewJson<T>(
      apiUrl(server, path, searchParams),
      { headers: { Accept: 'application/json', ...authHeaders(token) } },
      REQUEST_TIMEOUT_MS
    )
  } catch {
    return null
  }
}

function mapReviewState(state: MRInfo['state']): HostedReviewState {
  if (state === 'opened' || state === 'locked') {
    return 'open'
  }
  return state
}

// Mirror mapGitLabReview (forge-review-mappers) but stamp provider 'custom'.
function mapCustomReview(mr: MRInfo): HostedReviewInfo {
  return {
    provider: 'custom',
    number: mr.number,
    title: mr.title,
    state: mapReviewState(mr.state),
    url: mr.url,
    status: mr.pipelineStatus,
    updatedAt: mr.updatedAt,
    mergeable: mr.mergeable,
    ...(mr.headSha ? { headSha: mr.headSha } : {}),
    ...(mr.baseRefName ? { baseRefName: mr.baseRefName } : {}),
    ...(mr.conflictSummary ? { conflictSummary: mr.conflictSummary } : {})
  }
}

function toReviewInfo(raw: RawGitLabMergeRequest): HostedReviewInfo {
  const pipelineStatus = derivePipelineStatus(raw.head_pipeline ?? raw.pipeline ?? null)
  return mapCustomReview(mapMRInfo(raw, pipelineStatus))
}

async function fetchMergeRequest(
  ref: CustomGitServerRepoRef,
  token: string | null,
  iid: number
): Promise<HostedReviewInfo | null> {
  const raw = await requestJson<RawGitLabMergeRequest>(
    ref.server,
    token,
    `/projects/${projectId(ref)}/merge_requests/${iid}`
  )
  return raw ? toReviewInfo(raw) : null
}

function classifyCreateError(error: unknown): CreateHostedReviewResult {
  const message = error instanceof Error ? error.message : String(error)
  if (message) {
    console.warn('createCustomGitServerMergeRequest failed:', message)
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
        'Create MR failed: the custom server rejected the token. Update the token for this server in Settings → Integrations.'
    }
  }
  if (
    status === 409 ||
    lower.includes('already exists') ||
    lower.includes('already open') ||
    // GitLab's duplicate-MR validation message.
    lower.includes('another open merge request already exists')
  ) {
    return {
      ok: false,
      code: 'already_exists',
      error: 'A merge request already exists for this branch.'
    }
  }
  if (error instanceof HostedReviewApiRequestError && error.timedOut) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'MR creation may have completed. Refreshing branch review state...'
    }
  }
  if (status === 400 || status === 422 || lower.includes('validation')) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create MR failed: the server rejected the merge request. Check the base branch and branch state, then try again.'
    }
  }
  return {
    ok: false,
    code: 'unknown',
    error: 'Create MR failed: the custom server could not create the merge request. Try again in a moment.'
  }
}

/** Flavor client for GitLab-compatible servers (GitLab v4 merge-request API). */
export const gitlabCompatFlavorClient: CustomGitServerFlavorClient = {
  async verify(server, token): Promise<CustomGitServerVerifyResult | null> {
    const user = await requestJson<{ username?: string | null; name?: string | null }>(
      server,
      token,
      '/user'
    )
    if (!user) {
      return null
    }
    return { account: user.username ?? user.name ?? null }
  },

  async getReviewForBranch(ref, token, branch, linkedNumber): Promise<HostedReviewInfo | null> {
    const branchName = branch.replace(/^refs\/heads\//, '')
    if (branchName) {
      const list = await requestJson<RawGitLabMergeRequest[]>(
        ref.server,
        token,
        `/projects/${projectId(ref)}/merge_requests`,
        {
          source_branch: branchName,
          state: 'all',
          order_by: 'updated_at',
          sort: 'desc',
          per_page: LIST_PER_PAGE
        }
      )
      // Server filters by source_branch; most-recently-updated wins. Refetch the
      // single MR so head_pipeline / conflict detail (omitted from list) are present.
      const iid = list?.[0]?.iid
      if (typeof iid === 'number') {
        return fetchMergeRequest(ref, token, iid)
      }
    }
    if (typeof linkedNumber === 'number') {
      return fetchMergeRequest(ref, token, linkedNumber)
    }
    return null
  },

  getReviewByNumber(ref, token, number): Promise<HostedReviewInfo | null> {
    return fetchMergeRequest(ref, token, number)
  },

  async createReview(ref, token, input, repoPath, connectionId): Promise<CreateHostedReviewResult> {
    const base = normalizeHostedReviewBaseRef(input.base)
    const head = input.head ? normalizeHostedReviewHeadRef(input.head) : ''
    const rawTitle = input.title.trim()
    if (!base || !head || !rawTitle) {
      return {
        ok: false,
        code: 'validation',
        error: 'Create MR failed: base branch, head branch, and title are required.'
      }
    }
    if (head.toLowerCase() === base.toLowerCase()) {
      return {
        ok: false,
        code: 'validation',
        error: 'Create MR failed: choose a different base branch before creating a merge request.'
      }
    }

    const body =
      input.useTemplate && !input.body?.trim()
        ? await readHostedPullRequestTemplate(repoPath, connectionId)
        : (input.body ?? '')
    // GitLab has no `draft` create flag — the convention is a `Draft:` title prefix.
    const title = input.draft && !/^draft:\s*/i.test(rawTitle) ? `Draft: ${rawTitle}` : rawTitle

    try {
      const raw = await requestHostedReviewJson<RawGitLabMergeRequest>(
        apiUrl(ref.server, `/projects/${projectId(ref)}/merge_requests`),
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...authHeaders(token)
          },
          body: JSON.stringify({
            source_branch: head,
            target_branch: base,
            title,
            description: body
          })
        },
        CREATE_REQUEST_TIMEOUT_MS
      )
      const created = toReviewInfo(raw)
      if (created.number > 0) {
        return { ok: true, number: created.number, url: created.url }
      }
      return {
        ok: false,
        code: 'unknown_completion',
        error: 'MR creation may have completed. Refreshing branch review state...'
      }
    } catch (error) {
      return classifyCreateError(error)
    }
  }
}
