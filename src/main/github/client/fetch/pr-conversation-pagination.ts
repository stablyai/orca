import {
  mapPRConversationSources,
  parsePRConversationSources,
  parsePRReviewThreadResponse
} from './pr-conversation-response'
import {
  reviewConversationQuery,
  REVIEW_THREAD_REPLIES_QUERY,
  type PRConversationSource
} from './pr-review-threads-query'

export class IncompletePRConversationError extends Error {}

type PageInfo = { hasNextPage: boolean; endCursor: string | null } | undefined

function nextCursor(info: PageInfo, seen: Set<string>): string | null {
  if (!info) {
    throw new IncompletePRConversationError('Missing GitHub conversation page information')
  }
  if (!info.hasNextPage) {
    return null
  }
  if (!info.endCursor || seen.has(info.endCursor)) {
    throw new IncompletePRConversationError('GitHub conversation cursor did not advance')
  }
  seen.add(info.endCursor)
  return info.endCursor
}

function appendNodes<T extends { id: string } | null>(
  target: T[],
  nodes: T[],
  ids: Set<string>
): void {
  for (const node of nodes) {
    if (node && !ids.has(node.id)) {
      ids.add(node.id)
      target.push(node)
    }
  }
}

/** Complete independent sources once, then each unfinished thread, before normalizing/sorting. */
export async function readCompletePRConversation(
  initial: string,
  read: (query: string, variables: Record<string, string>) => Promise<string>
): Promise<ReturnType<typeof mapPRConversationSources>> {
  const sources = parsePRConversationSources(initial)
  try {
    const readSource = async (name: PRConversationSource, cursor: string) =>
      parsePRConversationSources(await read(reviewConversationQuery(name), { cursor }), name)
    await finishSource(
      sources.comments,
      async (cursor) => (await readSource('comments', cursor)).comments
    )
    await finishSource(
      sources.reviews,
      async (cursor) => (await readSource('reviews', cursor)).reviews
    )
    await finishSource(
      sources.reviewThreads,
      async (cursor) => (await readSource('reviewThreads', cursor)).reviewThreads
    )
    for (const thread of sources.reviewThreads?.nodes ?? []) {
      if (!thread) {
        continue
      }
      const seen = new Set<string>()
      const ids = new Set(thread.comments.nodes.flatMap((node) => (node ? [node.id] : [])))
      let cursor = nextCursor(thread.comments.pageInfo, seen)
      while (cursor) {
        const page = parsePRReviewThreadResponse(
          await read(REVIEW_THREAD_REPLIES_QUERY, { threadId: thread.id, cursor })
        )
        if (page.id !== thread.id) {
          throw new Error('Unexpected GitHub review thread')
        }
        appendNodes(thread.comments.nodes, page.comments.nodes, ids)
        cursor = nextCursor(page.comments.pageInfo, seen)
      }
    }
    return mapPRConversationSources(sources)
  } catch (cause) {
    if (cause instanceof IncompletePRConversationError) {
      throw cause
    }
    throw new IncompletePRConversationError('GitHub conversation pagination failed', { cause })
  }
}

async function finishSource<T extends { id: string } | null>(
  connection: { nodes: T[]; pageInfo?: Exclude<PageInfo, undefined> } | undefined,
  read: (
    cursor: string
  ) => Promise<{ nodes: T[]; pageInfo?: Exclude<PageInfo, undefined> } | undefined>
): Promise<void> {
  if (!connection) {
    return
  }
  const seen = new Set<string>()
  const ids = new Set(connection.nodes.flatMap((node) => (node ? [node.id] : [])))
  let cursor = nextCursor(connection.pageInfo, seen)
  while (cursor) {
    const page = await read(cursor)
    if (!page) {
      throw new Error('Incomplete GitHub conversation source')
    }
    appendNodes(connection.nodes, page.nodes, ids)
    cursor = nextCursor(page.pageInfo, seen)
  }
}
