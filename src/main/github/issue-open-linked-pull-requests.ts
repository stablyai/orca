import { z } from 'zod'
import type { LinkedPullRequestSummary } from '../../shared/github/pull-request-types'
import { ghExecFileAsync } from './gh-utils'
import type { GitHubApiRepository, GitHubRepoExecOptions } from './github-api-repository'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from './rate-limit'

const LINKED_PULL_REQUEST_FIELDS =
  '... on PullRequest { number title url state createdAt headRefName author { login } }'

const OPEN_LINKED_PULL_REQUESTS_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT], last: 50) {
        nodes {
          __typename
          ... on CrossReferencedEvent { source { __typename ${LINKED_PULL_REQUEST_FIELDS} } }
          ... on ConnectedEvent { subject { __typename ${LINKED_PULL_REQUEST_FIELDS} } }
        }
      }
    }
  }
}`

const linkedPullRequestSchema = z
  .object({
    __typename: z.string().optional(),
    number: z.number().optional(),
    title: z.string().nullish(),
    url: z.string().nullish(),
    state: z.string().nullish(),
    createdAt: z.string().nullish(),
    headRefName: z.string().nullish(),
    author: z.object({ login: z.string().nullish() }).nullish()
  })
  .nullish()

const openLinkedPullRequestsResponseSchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          issue: z
            .object({
              timelineItems: z
                .object({
                  nodes: z
                    .array(
                      z
                        .object({
                          source: linkedPullRequestSchema,
                          subject: linkedPullRequestSchema
                        })
                        .nullish()
                    )
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

type GraphQLLinkedPullRequest = z.infer<typeof linkedPullRequestSchema>

function toSummary(
  pr: GraphQLLinkedPullRequest | null | undefined
): LinkedPullRequestSummary | null {
  if (
    pr?.__typename !== 'PullRequest' ||
    pr.state !== 'OPEN' ||
    typeof pr.number !== 'number' ||
    !pr.url
  ) {
    return null
  }
  return {
    number: pr.number,
    title: pr.title ?? '',
    url: pr.url,
    author: pr.author?.login ?? 'ghost',
    headRefName: pr.headRefName ?? '',
    createdAt: pr.createdAt ?? ''
  }
}

/** Open PRs that mention or are connected to the issue; undefined when the lookup is skipped or fails. */
export async function getOpenLinkedPullRequests(
  repository: GitHubApiRepository,
  issueNumber: number,
  ghOptions: GitHubRepoExecOptions
): Promise<LinkedPullRequestSummary[] | undefined> {
  if (repositoryRateLimitGuard(repository, 'graphql', ghOptions).blocked) {
    return undefined
  }
  try {
    noteRepositoryRateLimitSpend(repository, 'graphql', 1, ghOptions)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '--cache',
        '300s',
        '-f',
        `query=${OPEN_LINKED_PULL_REQUESTS_QUERY}`,
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.repo}`,
        '-F',
        `number=${issueNumber}`
      ],
      ghOptions
    )
    const parsed = openLinkedPullRequestsResponseSchema.safeParse(JSON.parse(stdout))
    if (!parsed.success || (parsed.data.errors?.length ?? 0) > 0) {
      return undefined
    }
    const byNumber = new Map<number, LinkedPullRequestSummary>()
    for (const node of parsed.data.data?.repository?.issue?.timelineItems?.nodes ?? []) {
      const summary = toSummary(node?.source ?? node?.subject)
      if (summary) {
        byNumber.set(summary.number, summary)
      }
    }
    return [...byNumber.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  } catch {
    // Why: the linked-PR warning is auxiliary; the issue itself must still load.
    return undefined
  }
}
