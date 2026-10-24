import type { ExecutionHostId } from '../../shared/execution-host'
import type { CreateHostedReviewInput, CreateHostedReviewResult } from '../../shared/hosted-review'
import {
  normalizeHostedReviewBaseRef,
  normalizeHostedReviewHeadRef
} from '../../shared/hosted-review-refs'
import {
  HostedReviewApiRequestError,
  requestHostedReviewJson
} from '../source-control/hosted-review-api-request'
import { hostedReviewSshConnectionId } from '../source-control/hosted-review-execution-host'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { readHostedPullRequestTemplate } from '../source-control/pull-request-template'
import {
  hasBitbucketServerCredential,
  resolveBitbucketServerAuthConfig,
  serverAuthHeaders,
  type BitbucketServerAuthConfig
} from './server-auth-config'
import { bitbucketServerRepoApiPath, getBitbucketServerPullRequestForBranch } from './server-client'
import {
  mapBitbucketServerPullRequest,
  type RawBitbucketServerPullRequest
} from './server-pull-request-mappers'
import { getBitbucketServerRepoRef, type BitbucketServerRepoRef } from './server-repository-ref'

const CREATE_REQUEST_TIMEOUT_MS = 60_000
const LOOKUP_TIMEOUT_MS = 5000

const ALREADY_EXISTS = 'A pull request already exists for this branch.'

// Presence only, never decrypts: eligibility runs proactively for the sidebar.
export function isBitbucketServerReviewCreationAuthenticated(): boolean {
  return hasBitbucketServerCredential()
}

type RepositoryInfo = { id: number; projectKey: string; slug: string; currentUser: string | null }

async function getRepositoryInfo(
  config: BitbucketServerAuthConfig,
  repo: BitbucketServerRepoRef
): Promise<RepositoryInfo | null> {
  try {
    const response = await fetch(`${repo.baseUrl}${bitbucketServerRepoApiPath(repo)}`, {
      headers: { Accept: 'application/json', ...serverAuthHeaders(config) },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    })
    if (!response.ok) {
      return null
    }
    const body: unknown = await response.json()
    if (
      typeof body !== 'object' ||
      body === null ||
      !('id' in body) ||
      typeof body.id !== 'number'
    ) {
      return null
    }
    const project = 'project' in body ? body.project : null
    const projectKey =
      typeof project === 'object' &&
      project !== null &&
      'key' in project &&
      typeof project.key === 'string'
        ? project.key
        : repo.projectKey
    const slug = 'slug' in body && typeof body.slug === 'string' ? body.slug : repo.repoSlug
    return { id: body.id, projectKey, slug, currentUser: response.headers.get('X-AUSERNAME') }
  } catch {
    return null
  }
}

// Why: Server only applies repository default reviewers to PRs created in the web UI, not over REST.
async function getDefaultReviewers(
  config: BitbucketServerAuthConfig,
  repo: BitbucketServerRepoRef,
  info: RepositoryInfo | null,
  head: string,
  base: string
): Promise<{ user: { name: string } }[]> {
  if (!info) {
    return []
  }
  const url = new URL(
    `${repo.baseUrl}/rest/default-reviewers/1.0/projects/${encodeURIComponent(repo.projectKey)}/repos/${encodeURIComponent(repo.repoSlug)}/reviewers`
  )
  url.searchParams.set('sourceRepoId', String(info.id))
  url.searchParams.set('targetRepoId', String(info.id))
  url.searchParams.set('sourceRefId', `refs/heads/${head}`)
  url.searchParams.set('targetRefId', `refs/heads/${base}`)
  try {
    const response = await fetch(url.toString(), {
      headers: { Accept: 'application/json', ...serverAuthHeaders(config) },
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
    })
    if (!response.ok) {
      return []
    }
    const users: unknown = await response.json()
    if (!Array.isArray(users)) {
      return []
    }
    // Why: the server rejects the whole create with 409 when the author is listed as a reviewer.
    return users
      .map((user: unknown) =>
        typeof user === 'object' && user !== null && 'name' in user && typeof user.name === 'string'
          ? user.name
          : null
      )
      .filter((name): name is string => name !== null && name !== info.currentUser)
      .map((name) => ({ user: { name } }))
  } catch {
    return []
  }
}

function serverErrorMessage(error: HostedReviewApiRequestError): string | null {
  try {
    const parsed: unknown = JSON.parse(error.message)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'errors' in parsed &&
      Array.isArray(parsed.errors)
    ) {
      const first: unknown = parsed.errors[0]
      if (
        typeof first === 'object' &&
        first !== null &&
        'message' in first &&
        typeof first.message === 'string'
      ) {
        return first.message
      }
    }
  } catch {
    // Non-JSON body: no server reason to show.
  }
  return null
}

function classifyCreateError(error: unknown): CreateHostedReviewResult {
  console.warn(
    'createBitbucketServerPullRequest failed:',
    error instanceof Error ? error.message : String(error)
  )
  if (!(error instanceof HostedReviewApiRequestError)) {
    return {
      ok: false,
      code: 'unknown',
      error:
        'Create PR failed: Bitbucket Server could not create the pull request. Try again in a moment.'
    }
  }
  if (error.timedOut) {
    return {
      ok: false,
      code: 'unknown_completion',
      error: 'PR creation may have completed. Refreshing branch review state...'
    }
  }
  if (error.status === 401 || error.status === 403) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Bitbucket Server is not authenticated. Next step: connect Bitbucket Data Center in Settings > Integrations.'
    }
  }
  if (error.status === 404) {
    return {
      ok: false,
      code: 'validation',
      error:
        'Create PR failed: Bitbucket Server could not find the repository or branch. Push the branch, then try again.'
    }
  }
  const reason = serverErrorMessage(error)
  return {
    ok: false,
    code: 'validation',
    error: reason
      ? `Create PR failed: Bitbucket Server rejected the pull request: ${reason}`
      : 'Create PR failed: Bitbucket Server rejected the pull request. Check the base branch and branch state, then try again.'
  }
}

export async function createBitbucketServerPullRequest(
  repoPath: string,
  input: CreateHostedReviewInput,
  executionHostId: ExecutionHostId,
  options: HostedReviewExecutionOptions = {}
): Promise<CreateHostedReviewResult> {
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

  // The REST calls run on this client; only the git reads under them are routed.
  const connectionId = hostedReviewSshConnectionId(executionHostId)
  const config = resolveBitbucketServerAuthConfig()
  if (!config.accessToken) {
    return {
      ok: false,
      code: 'auth_required',
      error:
        'Create PR failed: Bitbucket Server is not connected. Next step: connect Bitbucket Data Center in Settings > Integrations.'
    }
  }
  const repo = await getBitbucketServerRepoRef(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
  if (!repo) {
    return {
      ok: false,
      code: 'unsupported_provider',
      error: 'Creating pull requests requires a Bitbucket Server remote.'
    }
  }

  const description =
    input.useTemplate && !input.body?.trim()
      ? await readHostedPullRequestTemplate(repoPath, connectionId)
      : (input.body ?? '')
  const info = await getRepositoryInfo(config, repo)
  const reviewers = await getDefaultReviewers(config, repo, info, head, base)
  const repository = {
    slug: info?.slug ?? repo.repoSlug,
    project: { key: info?.projectKey ?? repo.projectKey }
  }
  const findExisting = async (): Promise<{ number: number; url: string } | null> => {
    const existing = await getBitbucketServerPullRequestForBranch(
      repoPath,
      head,
      null,
      connectionId,
      options
    ).catch(() => null)
    return existing?.state === 'open' ? { number: existing.number, url: existing.url } : null
  }

  try {
    const raw = await requestHostedReviewJson<RawBitbucketServerPullRequest>(
      new URL(`${repo.baseUrl}${bitbucketServerRepoApiPath(repo)}/pull-requests`),
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...serverAuthHeaders(config)
        },
        body: JSON.stringify({
          title,
          description,
          fromRef: { id: `refs/heads/${head}`, repository },
          toRef: { id: `refs/heads/${base}`, repository },
          reviewers
        })
      },
      CREATE_REQUEST_TIMEOUT_MS
    )
    const created = mapBitbucketServerPullRequest(raw, 'neutral', 'UNKNOWN')
    if (created) {
      return { ok: true, number: created.number, url: created.url }
    }
    const found = await findExisting()
    return found
      ? { ok: true, ...found }
      : {
          ok: false,
          code: 'unknown_completion',
          error: 'PR creation may have completed. Refreshing branch review state...'
        }
  } catch (error) {
    const classified = classifyCreateError(error)
    // Why: 409 covers several cases (duplicate, same branch, up to date), so only a found open PR proves "already exists".
    const mayExist =
      (error instanceof HostedReviewApiRequestError && error.status === 409) ||
      (!classified.ok && classified.code === 'unknown_completion')
    if (mayExist) {
      const existing = await findExisting()
      if (existing) {
        return {
          ok: false,
          code: 'already_exists',
          error: ALREADY_EXISTS,
          existingReview: existing
        }
      }
    }
    return classified
  }
}
