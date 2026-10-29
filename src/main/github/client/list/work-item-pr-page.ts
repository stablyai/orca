import { z } from 'zod'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import { ghExecFileAsync, type OwnerRepo } from '../../gh-utils'
import type { GitHubRepoExecOptions } from '../../github-api-repository'
import { mapPullRequestWorkItem } from '../map/work-item'
import type { MainWorkItem } from '../map/work-item-field-coercion'
import { buildWorkItemListRequest } from './work-item-list-request'
import { searchWorkItemPage, usesGraphqlWorkItemSearch } from './work-item-search-page'

const PR_NODE_SELECTION = `__typename ... on PullRequest {
  number title state url updatedAt isDraft headRefName baseRefName headRefOid
  headRepositoryOwner { login }
  author { __typename login avatarUrl ... on User { name } }
  labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
  reviewRequests(first: 100) {
    nodes { requestedReviewer {
      __typename
      ... on User { login name avatarUrl }
      ... on Bot { login avatarUrl }
      ... on Team { slug name }
      ... on Mannequin { login avatarUrl }
    } }
    pageInfo { hasNextPage }
  }
}`
const actorSchema = z.object({
  __typename: z.string().optional(),
  login: z.string(),
  avatarUrl: z.string(),
  name: z.string().nullish()
})
const prNodeSchema = z.object({
  __typename: z.literal('PullRequest'),
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  url: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  headRefName: z.string(),
  baseRefName: z.string(),
  headRefOid: z.string(),
  headRepositoryOwner: z.object({ login: z.string() }).nullable(),
  author: actorSchema.nullable(),
  labels: z.object({
    nodes: z.array(z.object({ name: z.string() })),
    pageInfo: z.object({ hasNextPage: z.literal(false) })
  }),
  reviewRequests: z.object({
    nodes: z.array(
      z
        .object({
          requestedReviewer: z
            .object({
              login: z.string().optional(),
              avatarUrl: z.string().optional(),
              name: z.string().nullish()
            })
            .nullable()
        })
        .nullable()
    ),
    pageInfo: z.object({ hasNextPage: z.literal(false) })
  })
})

export async function listPullRequestWorkItemPage(args: {
  ownerRepo: OwnerRepo
  query: ParsedTaskQuery
  limit: number
  page: number
  options: GitHubRepoExecOptions
  noCache?: boolean
}): Promise<MainWorkItem[]> {
  const request = buildWorkItemListRequest({ kind: 'pr', ...args })
  const preferGraphql = args.limit <= 100 && usesGraphqlWorkItemSearch(args.ownerRepo, args.options)
  const options = preferGraphql
    ? { ...args.options, env: { ...(args.options.env ?? process.env) } }
    : args.options
  if (preferGraphql) {
    try {
      const nodes = await searchWorkItemPage({
        search: request.search,
        searchType: 'ISSUE_ADVANCED',
        nodeSelection: PR_NODE_SELECTION,
        limit: args.limit,
        page: args.page,
        options,
        noCache: args.noCache,
        cacheResults: false
      })
      return z
        .array(prNodeSchema)
        .parse(nodes)
        .map((node) =>
          mapPullRequestWorkItem(
            {
              ...node,
              author:
                node.author?.__typename === 'Bot'
                  ? { ...node.author, login: `app/${node.author.login}` }
                  : node.author,
              labels: node.labels.nodes,
              reviewRequests: node.reviewRequests.nodes
            },
            args.ownerRepo
          )
        )
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
    }
  }
  const { stdout } = await ghExecFileAsync(request.args, options)
  return z
    .array(z.record(z.string(), z.unknown()))
    .parse(JSON.parse(stdout))
    .slice(request.offset, request.offset + args.limit)
    .map((item) => mapPullRequestWorkItem(item, args.ownerRepo))
}
