import { BoundedMap } from '../../../../shared/bounded-map'
import { isDefaultGitHubHost } from '../../../../shared/github/repository-identity-key'
import type { OwnerRepo } from '../../gh-utils'
import type { GitHubRepoExecOptions } from '../../github-api-repository'
import {
  requestWorkItemSearch,
  workItemSearchScope,
  WORK_ITEM_SEARCH_CACHE_MS
} from './work-item-search-batch'

type PageInfo = { endCursor: string | null; hasNextPage: boolean }

export type SearchConnection<T> = { issueCount: number; pageInfo: PageInfo; nodes: T[] }

const cursors = new BoundedMap<string, { at: number; cursor: string }>({
  maxEntries: 1024,
  maxBytes: 1024 * 1024,
  sizeOf: (value, key) => Buffer.byteLength(key) + Buffer.byteLength(value.cursor) + 8
})

export function usesGraphqlWorkItemSearch(
  ownerRepo: OwnerRepo,
  options: GitHubRepoExecOptions
): boolean {
  return isDefaultGitHubHost(
    ownerRepo.host ?? options.host ?? options.env?.GH_HOST ?? process.env.GH_HOST
  )
}

export async function searchWorkItemCount(
  search: string,
  options: GitHubRepoExecOptions
): Promise<number> {
  const { value: result } = await requestWorkItemSearch<{ issueCount: number }>({
    search,
    first: 1,
    selection: 'issueCount',
    options
  })

  if (!Number.isSafeInteger(result.issueCount) || result.issueCount < 0) {
    throw new Error('GitHub search response missing count')
  }

  return result.issueCount
}

export async function searchWorkItemPage<T>(args: {
  search: string
  nodeSelection: string
  limit: number
  page: number
  options: GitHubRepoExecOptions
  noCache?: boolean
}): Promise<T[]> {
  const { options, noCache } = args
  const environment = { ...(options.env ?? process.env) }

  if (!Number.isSafeInteger(args.limit) || args.limit < 1) {
    throw new Error('Invalid GitHub search page limit')
  }

  const limit = Math.min(100, args.limit)
  const offset = (args.page - 1) * limit

  if (offset + limit > 1000) {
    throw new Error('Only the first 1000 search results are available (HTTP 422)')
  }

  const search = `${args.search} sort:created-desc`
  const scope = JSON.stringify([workItemSearchScope(options, environment), search])
  let position = 0
  let after: string | undefined

  if (!noCache) {
    for (let at = offset; at > 0; at--) {
      const cached = cursors.get(`${scope}:${at}`)

      if (cached && Date.now() - cached.at < WORK_ITEM_SEARCH_CACHE_MS) {
        position = at
        after = cached.cursor
        break
      }
    }
  }

  const remember = (position: number, info: PageInfo, at: number): void => {
    if (
      typeof info.hasNextPage !== 'boolean' ||
      (info.endCursor !== null && typeof info.endCursor !== 'string')
    ) {
      throw new Error('GitHub search response invalid pagination')
    }

    if (info.hasNextPage && !info.endCursor) {
      throw new Error('GitHub search response missing cursor')
    }

    if (!noCache && info.endCursor) {
      cursors.set(`${scope}:${position}`, { at, cursor: info.endCursor })
    }
  }

  while (position < offset) {
    const first = Math.min(100, offset - position)

    const { value: skipped, at } = await requestWorkItemSearch<SearchConnection<never>>({
      search,
      first,
      after,
      selection: 'issueCount pageInfo { endCursor hasNextPage }',
      options,
      environment,
      noCache
    })

    if (!skipped.pageInfo || !Number.isSafeInteger(skipped.issueCount)) {
      throw new Error('GitHub search response missing pagination')
    }

    if (skipped.issueCount <= offset) {
      return []
    }

    if (!skipped.pageInfo.hasNextPage) {
      throw new Error('GitHub search pagination ended before requested page')
    }

    position += first
    remember(position, skipped.pageInfo, at)
    after = skipped.pageInfo.endCursor ?? undefined
  }

  const { value: result, at } = await requestWorkItemSearch<SearchConnection<T>>({
    search,
    first: limit,
    after,
    selection: `issueCount pageInfo { endCursor hasNextPage } nodes { ${args.nodeSelection} }`,
    options,
    environment,
    noCache
  })

  if (!Array.isArray(result.nodes) || !result.pageInfo) {
    throw new Error('GitHub search response missing page')
  }

  remember(offset + result.nodes.length, result.pageInfo, at)

  return result.nodes
}
