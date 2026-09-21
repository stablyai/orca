import { z } from 'zod'
import type { ParsedTaskQuery } from '../../../../shared/task-query'
import { ghExecFileAsync, type LocalGitExecOptions, type OwnerRepo } from '../../gh-utils'
import { noteRepositoryRateLimitSpend } from '../../rate-limit'
import type { GitHubRepoExecOptions } from '../../github-api-repository'
import { fetchIssueWorkItem } from '../fetch/work-item-fetch'
import { mapIssueWorkItem } from '../map/work-item'
import type { MainWorkItem } from '../map/work-item-field-coercion'
import { buildWorkItemListRequest } from './work-item-list-request'
import { buildSearchQueryString } from './work-item-search-query'
import { searchWorkItemPage, usesGraphqlWorkItemSearch } from './work-item-search-page'

type Actor = { __typename?: string; login: string; avatarUrl?: string }
type IssueNode = {
  __typename: string
  number: number
  title: string
  state: string
  url: string
  updatedAt: string
  author: Actor | null
  labels: { nodes: { name: string }[]; pageInfo: { hasNextPage: boolean } }
  assignees: { nodes: Actor[]; pageInfo: { hasNextPage: boolean } }
}
const ISSUE_NODE_SELECTION = `__typename ... on Issue {
  number title state url updatedAt
  author { __typename login avatarUrl }
  labels(first: 100) { nodes { name } pageInfo { hasNextPage } }
  assignees(first: 100) { nodes { __typename login avatarUrl } pageInfo { hasNextPage } }
}`

function restActor(actor: Actor | null): Record<string, unknown> | null {
  if (!actor) {
    return null
  }
  const login =
    actor.__typename === 'Bot' && !actor.login.endsWith('[bot]')
      ? `${actor.login}[bot]`
      : actor.login
  let avatar = actor.avatarUrl
  if (avatar) {
    const url = new URL(avatar)
    if (url.hostname === 'avatars.githubusercontent.com') {
      url.searchParams.delete('u')
      avatar = url.toString()
    }
  }
  return { login, avatar_url: avatar }
}

export async function listIssueWorkItemPage(args: {
  repoPath: string
  ownerRepo: OwnerRepo
  query: ParsedTaskQuery
  limit: number
  page: number
  options: GitHubRepoExecOptions
  connectionId?: string | null
  localGitOptions?: LocalGitExecOptions
  noCache?: boolean
}): Promise<MainWorkItem[]> {
  const preferGraphql = usesGraphqlWorkItemSearch(args.ownerRepo, args.options)
  const options = preferGraphql
    ? { ...args.options, env: { ...(args.options.env ?? process.env) } }
    : args.options
  if (preferGraphql) {
    try {
      const nodes = await searchWorkItemPage<IssueNode>({
        search: buildSearchQueryString(args.ownerRepo, { ...args.query, scope: 'issue' }),
        nodeSelection: ISSUE_NODE_SELECTION,
        limit: args.limit,
        page: args.page,
        options,
        noCache: args.noCache
      })
      const items: MainWorkItem[] = []
      for (const node of nodes) {
        if (!node || node.__typename !== 'Issue') {
          throw new Error('GitHub issue search response missing issue')
        }
        if (
          !Number.isSafeInteger(node.number) ||
          node.number <= 0 ||
          typeof node.title !== 'string' ||
          typeof node.url !== 'string' ||
          typeof node.updatedAt !== 'string' ||
          !['OPEN', 'CLOSED'].includes(node.state)
        ) {
          throw new Error('GitHub issue search response missing fields')
        }
        if (!node.labels?.pageInfo || !node.assignees?.pageInfo) {
          throw new Error('GitHub issue search response missing association completeness')
        }
        if (node.labels.pageInfo.hasNextPage || node.assignees.pageInfo.hasNextPage) {
          const complete = await fetchIssueWorkItem(
            args.repoPath,
            args.ownerRepo,
            node.number,
            args.connectionId,
            args.localGitOptions,
            options.env
          )
          if (!complete) {
            throw new Error('GitHub issue detail response missing issue')
          }
          items.push(complete)
          continue
        }
        items.push(
          mapIssueWorkItem({
            ...node,
            state: node.state.toLowerCase(),
            user: restActor(node.author),
            labels: node.labels.nodes,
            assignees: node.assignees.nodes.map(restActor)
          })
        )
      }
      return items
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw error
      }
      // REST retains exact search semantics when GraphQL is unavailable for this credential.
    }
  }
  const request = buildWorkItemListRequest({ kind: 'issue', ...args })
  if (args.noCache) {
    request.args.splice(1, 2)
  }
  const { stdout } = await ghExecFileAsync(request.args, options)
  noteRepositoryRateLimitSpend(args.ownerRepo, 'search', 1, options)
  return z
    .array(z.record(z.string(), z.unknown()))
    .parse(JSON.parse(stdout))
    .filter((item) => !('pull_request' in item))
    .map(mapIssueWorkItem)
}
