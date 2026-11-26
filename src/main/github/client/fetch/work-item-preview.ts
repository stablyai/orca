import { z } from 'zod'
import type { GitHubRepositoryIdentity } from '../../../../shared/github/repositories/repository-identity'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../../../git/command-runner/process-capture/exec-error'
import { noteRepositoryRateLimitSpend, repositoryRateLimitGuard } from '../../api/rate-limit'
import { extractGraphqlErrors } from '../../project-view/project-error-classification'
import { githubHostExecOptions } from '../../repositories/github-repository-host'
import {
  ghRepoExecOptions,
  githubRepoContext,
  type LocalGitExecOptions
} from '../../repositories/github-repository-identity'
import type { GhExecOptions } from '../github-exec-scope'
import { restIssueActor } from '../map/issue-actor'
import type { MainWorkItem } from '../map/work-item-field-coercion'
import { mapIssueWorkItem, mapPullRequestWorkItem } from '../map/work-item'

const COMMON_FIELDS = `number title url updatedAt
  author { __typename login avatarUrl }
  labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
  assignees(first: 100) { nodes { login avatarUrl } pageInfo { hasNextPage } }`
const NUMBER_PREVIEW_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { ${COMMON_FIELDS} issueState: state comments { totalCount } }
      ... on PullRequest {
        ${COMMON_FIELDS}
        pullState: state isDraft headRefName baseRefName headRefOid headRepositoryOwner { login }
        additions deletions changedFiles mergeable mergeStateStatus autoMergeRequest { enabledAt }
        reviewRequests(first: 100) {
          nodes { requestedReviewer {
            __typename
            ... on User { login avatarUrl }
            ... on Bot { login avatarUrl }
            ... on Mannequin { login avatarUrl }
          } }
          pageInfo { hasNextPage }
        }
      }
    }
  }
}`

const actorSchema = z.object({ login: z.string(), avatarUrl: z.string() })
const labeledActorSchema = actorSchema.extend({ __typename: z.string() })
const connection = <T extends z.ZodType>(node: T) =>
  z.object({ nodes: z.array(node), pageInfo: z.object({ hasNextPage: z.literal(false) }) })
const commonSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  author: labeledActorSchema.nullable(),
  labels: connection(z.object({ name: z.string() })),
  assignees: connection(actorSchema)
})
const previewSchema = z.discriminatedUnion('__typename', [
  commonSchema.extend({
    __typename: z.literal('Issue'),
    issueState: z.enum(['OPEN', 'CLOSED']),
    comments: z.object({ totalCount: z.number().int().nonnegative() })
  }),
  commonSchema.extend({
    __typename: z.literal('PullRequest'),
    pullState: z.enum(['OPEN', 'CLOSED', 'MERGED']),
    isDraft: z.boolean(),
    headRefName: z.string(),
    baseRefName: z.string(),
    headRefOid: z.string(),
    headRepositoryOwner: z.object({ login: z.string() }),
    additions: z.number(),
    deletions: z.number(),
    changedFiles: z.number(),
    mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']),
    mergeStateStatus: z.string().nullable(),
    autoMergeRequest: z.object({ enabledAt: z.string() }).nullable(),
    reviewRequests: connection(
      z.object({
        requestedReviewer: z
          .union([labeledActorSchema, z.object({ __typename: z.literal('Team') })])
          .nullable()
      })
    )
  })
])
const previewResponseSchema = z.object({
  data: z.object({ repository: z.object({ issueOrPullRequest: previewSchema }) }),
  errors: z.array(z.unknown()).optional()
})

async function readNumberPreview(
  repository: GitHubRepositoryIdentity,
  number: number,
  options: GhExecOptions
): Promise<MainWorkItem | null | undefined> {
  if (
    repository.host !== 'github.com' ||
    repositoryRateLimitGuard(repository, 'graphql', options).blocked
  ) {
    return undefined
  }
  try {
    noteRepositoryRateLimitSpend(repository, 'graphql', 1, options)
    const { stdout } = await ghExecFileAsync(
      [
        'api',
        'graphql',
        '-f',
        `query=${NUMBER_PREVIEW_QUERY}`,
        '-f',
        `owner=${repository.owner}`,
        '-f',
        `repo=${repository.repo}`,
        '-F',
        `number=${number}`
      ],
      options
    )
    const parsed = previewResponseSchema.parse(JSON.parse(stdout))
    const item = parsed.data.repository.issueOrPullRequest
    if (parsed.errors?.length || item.number !== number) {
      return undefined
    }
    const associations = {
      user: restIssueActor(item.author),
      labels: item.labels.nodes,
      assignees: item.assignees.nodes.map(restIssueActor)
    }
    if (item.__typename === 'Issue') {
      return mapIssueWorkItem({
        ...item,
        ...associations,
        state: item.issueState.toLowerCase(),
        comments: item.comments.totalCount
      })
    }
    return mapPullRequestWorkItem(
      {
        ...item,
        ...associations,
        state: item.pullState,
        mergeable: item.mergeable === 'UNKNOWN' ? null : item.mergeable,
        reviewRequests: item.reviewRequests.nodes.map(({ requestedReviewer }) =>
          requestedReviewer && 'login' in requestedReviewer
            ? restIssueActor(requestedReviewer)
            : null
        )
      },
      repository
    )
  } catch (error) {
    const { stdout, stderr } = extractExecError(error)
    const errors = extractGraphqlErrors(stderr, stdout)
    return errors.length &&
      errors.every(
        ({ type, path }) =>
          type === 'NOT_FOUND' &&
          path?.length === 2 &&
          path[0] === 'repository' &&
          path[1] === 'issueOrPullRequest'
      )
      ? null
      : undefined
  }
}

export async function fetchWorkItemPreview(
  repoPath: string,
  ownerRepo: GitHubRepositoryIdentity,
  number: number,
  type: 'issue' | 'pr',
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<MainWorkItem | null> {
  const ghOptions = {
    ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
    ...githubHostExecOptions(ownerRepo)
  }
  const base = `repos/${ownerRepo.owner}/${ownerRepo.repo}`
  if (type === 'issue') {
    // Bare #N links use the issue URL for both kinds of item.
    const preview = await readNumberPreview(ownerRepo, number, ghOptions)
    if (preview !== undefined) {
      return preview
    }
    const { stdout } = await ghExecFileAsync(['api', `${base}/issues/${number}`], ghOptions)
    const item: Record<string, unknown> = JSON.parse(stdout)
    if (!('pull_request' in item)) {
      return mapIssueWorkItem(item)
    }
  }
  const { stdout } = await ghExecFileAsync(['api', `${base}/pulls/${number}`], ghOptions)
  const pull: Record<string, unknown> = JSON.parse(stdout)
  return mapPullRequestWorkItem(pull, ownerRepo)
}
