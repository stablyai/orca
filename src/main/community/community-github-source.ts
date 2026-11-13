import { classifyCommunityPullRequest } from './community-pr-classification'
import { z } from 'zod'
import type { CommunityPullRequest } from '../../shared/community-catalog'
import { readFetchResponseJsonWithinLimit } from '../../shared/fetch-response-body'
import { githubBodyImageCandidates } from '../github/attachments/body-image-urls'
import { PrioritySemaphore } from '../../shared/priority-semaphore'

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.enum(['open', 'closed']),
  draft: z.boolean().nullish(),
  merged_at: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  head: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  body: z.string().nullable(),
  comments: z.number().int().nonnegative().optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  changed_files: z.number().int().nonnegative().optional(),
  reactions: z.object({ '+1': z.number().int().nonnegative() }).optional()
})

export class CommunityGitHubError extends Error {
  constructor(
    message: string,
    readonly retryAt: string | null = null
  ) {
    super(message)
  }
}

export class CommunityGitHubSource {
  private readonly slots = new PrioritySemaphore(2)
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly token: () => Promise<string | null> = async () => null
  ) {}

  async request(path: string, signal: AbortSignal): Promise<unknown> {
    const release = await this.slots.acquire(path.includes('?') ? 1 : 0, signal)
    try {
      return await this.fetchResponse(path, signal)
    } finally {
      release()
    }
  }

  async authenticated(): Promise<boolean> {
    return (await this.token()) !== null
  }
  async graphql(
    query: string,
    variables: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    const release = await this.slots.acquire(1, signal)
    try {
      const response = await this.fetchResponse('graphql', signal, { query, variables })
      const result = z
        .object({
          data: z.unknown().optional(),
          errors: z.array(z.object({ message: z.string() })).optional()
        })
        .parse(response)
      if (result.errors?.length || !result.data) {
        throw new Error('GitHub did not return complete review evidence.')
      }
      return result.data
    } finally {
      release()
    }
  }
  private async fetchResponse(path: string, signal: AbortSignal, body?: unknown): Promise<unknown> {
    const token = await this.token()
    const response = await this.fetcher(
      body
        ? 'https://api.github.com/graphql'
        : `https://api.github.com/repos/stablyai/orca/${path}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      }
    )
    if (!response.ok) {
      await response.body?.cancel()
      const retry = Number(response.headers.get('retry-after'))
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      const retryAt =
        retry > 0
          ? new Date(Date.now() + retry * 1000).toISOString()
          : reset > 0
            ? new Date(reset * 1000).toISOString()
            : null
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (response.headers.get('x-ratelimit-remaining') === '0' || retry > 0))
      throw new CommunityGitHubError(
        limited
          ? 'GitHub limited this request. Try again after the displayed retry time.'
          : `GitHub request failed (HTTP ${response.status}).`,
        limited ? (retryAt ?? new Date(Date.now() + 60_000).toISOString()) : null
      )
    }
    return readFetchResponseJsonWithinLimit(response, 8 * 1024 * 1024)
  }

  private normalize(
    raw: z.infer<typeof pullRequestSchema>,
    observedAt: string,
    _previous?: CommunityPullRequest
  ): CommunityPullRequest {
    if (raw.html_url !== `https://github.com/stablyai/orca/pull/${raw.number}`) {
      throw new Error('GitHub returned a different repository')
    }
    const inferred = classifyCommunityPullRequest(raw.title)
    const imageUrls = [...githubBodyImageCandidates(raw.body ?? '').values()]
      .filter(
        (url) =>
          url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/assets/')
      )
      .slice(0, 24)
      .map((url) => url.href)
    return {
      number: raw.number,
      title: raw.title,
      displayTitle: raw.title,
      url: raw.html_url,
      author: raw.user?.login ?? 'Deleted account',
      createdAt: raw.created_at,
      updatedAt: raw.updated_at,
      isDraft: raw.draft ?? false,
      ...inferred,
      comments: raw.comments ?? null,
      prThumbsUp: raw.reactions?.['+1'] ?? null,
      closingIssues: [],
      headSha: raw.head.sha,
      reviewDecision: null,
      checkState: null,
      checkObserved: false,
      additions: raw.additions ?? null,
      deletions: raw.deletions ?? null,
      changedFiles: raw.changed_files ?? null,
      imageUrls,
      observedAt,
      state: raw.merged_at ? 'merged' : raw.state
    }
  }

  async page(
    page: number,
    mode: 'full' | 'incremental',
    signal: AbortSignal,
    previous: Map<number, CommunityPullRequest>
  ): Promise<CommunityPullRequest[]> {
    const query =
      mode === 'full'
        ? 'state=open&sort=created&direction=asc'
        : 'state=all&sort=updated&direction=desc'
    const rows = z
      .array(pullRequestSchema)
      .max(100)
      .parse(await this.request(`pulls?${query}&per_page=100&page=${page}`, signal))
    const at = new Date().toISOString()
    return rows.map((row) => this.normalize(row, at, previous.get(row.number)))
  }

  async detail(
    number: number,
    signal: AbortSignal,
    _previous?: CommunityPullRequest
  ): Promise<CommunityPullRequest> {
    return this.normalize(
      pullRequestSchema.parse(await this.request(`pulls/${number}`, signal)),
      new Date().toISOString(),
      _previous
    )
  }
}
