import { captureCommunitySourceDiff } from './community-source-diff'
import { z } from 'zod'
import type { CommunityGitHubSource } from './community-github-source'
import type {
  CommunitySourceDiff,
  CommunityCheck,
  CommunityReview
} from '../../shared/community-operations'
const url = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:')
  .nullable()
const review = z.object({
  user: z.object({ login: z.string() }).nullable(),
  state: z.string(),
  commit_id: z.string(),
  submitted_at: z.string().nullable(),
  html_url: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://github.com/'))
})
const check = z.object({
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: url
})
const raw = z.object({
  body: z.string().nullable(),
  head: z.object({ sha: z.string() }),
  base: z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }),
  changed_files: z.number().int().nonnegative(),
  merge_commit_sha: z.string().nullable(),
  merged_at: z.string().nullable()
})
export async function communityGitHubDetail(
  source: CommunityGitHubSource,
  number: number,
  expectedHead: string,
  signal: AbortSignal
): Promise<{
  body: string
  diff: CommunitySourceDiff | null
  checks: CommunityCheck[]
  checksObserved: boolean
  checksComplete: boolean
  reviews: CommunityReview[]
  reviewsObserved: boolean
  reviewsComplete: boolean
  mergeCommit: string | null
  mergedAt: string | null
  warnings: string[]
}> {
  const [detailResult, reviewsResult, checksResult, statusesResult] = await Promise.allSettled([
    source.request(`pulls/${number}`, signal).then((value) => raw.parse(value)),
    source
      .request(`pulls/${number}/reviews?per_page=100`, signal)
      .then((value) => z.array(review).parse(value)),
    source
      .request(`commits/${expectedHead}/check-runs?per_page=100`, signal)
      .then((value) =>
        z.object({ total_count: z.number(), check_runs: z.array(check) }).parse(value)
      ),
    source.request(`commits/${expectedHead}/status?per_page=100`, signal).then((value) =>
      z
        .object({
          total_count: z.number(),
          statuses: z.array(z.object({ context: z.string(), state: z.string(), target_url: url }))
        })
        .parse(value)
    )
  ])
  const detail = detailResult.status === 'fulfilled' ? detailResult.value : null
  if (detail && detail.head.sha !== expectedHead) {
    throw new Error('The PR changed during inspection. Refresh this proposal.')
  }
  const reviews = reviewsResult.status === 'fulfilled' ? reviewsResult.value : []
  const checks = checksResult.status === 'fulfilled' ? checksResult.value : null
  const statuses = statusesResult.status === 'fulfilled' ? statusesResult.value : null
  const warnings = [detailResult, reviewsResult, checksResult, statusesResult].flatMap((result) =>
    result.status === 'rejected'
      ? [
          result.reason instanceof Error
            ? result.reason.message
            : 'GitHub evidence was unavailable.'
        ]
      : []
  )
  let diff: CommunitySourceDiff | null = null
  if (detail) {
    try {
      diff = await captureCommunitySourceDiff(
        source,
        detail.base.sha,
        expectedHead,
        detail.changed_files,
        signal
      )
    } catch {
      warnings.push('The pinned source diff could not be captured. AI review needs this evidence.')
    }
  }
  return {
    diff,
    body: detail?.body ?? '',
    mergeCommit: detail?.merge_commit_sha ?? null,
    mergedAt: detail?.merged_at ?? null,
    checks: [
      ...(checks?.check_runs ?? []).map((row) => ({
        name: row.name,
        state: row.conclusion ?? row.status,
        url: row.html_url
      })),
      ...(statuses?.statuses ?? []).map((row) => ({
        name: row.context,
        state: row.state,
        url: row.target_url
      }))
    ],
    checksObserved: checks !== null && statuses !== null,
    checksComplete:
      checks !== null &&
      statuses !== null &&
      checks.total_count <= checks.check_runs.length &&
      statuses.total_count <= statuses.statuses.length,
    reviews: reviews.map((row) => ({
      author: row.user?.login ?? 'Deleted account',
      state: row.state,
      commit: row.commit_id,
      at: row.submitted_at,
      url: row.html_url
    })),
    reviewsObserved: reviewsResult.status === 'fulfilled',
    reviewsComplete: reviewsResult.status === 'fulfilled' && reviews.length < 100,
    warnings
  }
}
