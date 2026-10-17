import { z } from 'zod'
import type { RelandedPullRequestSummary } from '../../../../shared/github/pull-request-types'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../rate-limit'

const RELANDINGS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50) {
        nodes {
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on PullRequest { number title url merged mergedAt author { login } }
            }
          }
        }
      }
    }
  }
}`

const referencingPullRequestSchema = z
  .object({
    __typename: z.string().optional(),
    number: z.number().optional(),
    title: z.string().nullish(),
    url: z.string().nullish(),
    merged: z.boolean().nullish(),
    mergedAt: z.string().nullish(),
    author: z.object({ login: z.string().nullish() }).nullish()
  })
  .nullish()

const relandingsResponseSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              timelineItems: z
                .object({
                  nodes: z
                    .array(z.object({ source: referencingPullRequestSchema }).nullish())
                    .nullish()
                })
                .nullish()
            })
            .nullish()
        })
        .nullish()
    })
    .nullish(),
  errors: z.array(z.unknown()).nullish()
})

/** Merged PRs that reference `prNumber`, newest merge first; empty when none or on failure. */
export async function getPRRelandings(
  repoPath: string,
  prNumber: number,
  options?: { prRepo?: GitHubApiRepository | null },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<RelandedPullRequestSummary[]> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    options?.prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo || repositoryRateLimitGuard(ownerRepo, 'graphql', ghOptions).blocked) {
    return []
  }
  await acquire()
  try {
    noteRepositoryRateLimitSpend(ownerRepo, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '--cache',
        '300s',
        '-f',
        `query=${RELANDINGS_QUERY}`,
        '-f',
        `owner=${ownerRepo.owner}`,
        '-f',
        `repo=${ownerRepo.repo}`,
        '-F',
        `number=${prNumber}`
      ],
      ghOptions
    )
    const parsed = relandingsResponseSchema.safeParse(JSON.parse(stdout))
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
      return []
    }
    const byNumber = new Map<number, RelandedPullRequestSummary>()
    for (const node of parsed.data.data?.repository?.pullRequest?.timelineItems?.nodes ?? []) {
      const pr = node?.source
      if (
        pr?.__typename !== 'PullRequest' ||
        !pr.merged ||
        typeof pr.number !== 'number' ||
        !pr.url
      ) {
        continue
      }
      byNumber.set(pr.number, {
        number: pr.number,
        title: pr.title ?? '',
        url: pr.url,
        author: pr.author?.login ?? 'ghost',
        mergedAt: pr.mergedAt ?? ''
      })
    }
    return [...byNumber.values()].sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
  } catch {
    // Why: where a closed PR landed is auxiliary; a failed lookup just shows nothing.
    return []
  } finally {
    release()
  }
}
