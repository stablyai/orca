import type {
  OmpRpcHistoryMessage,
  OmpRpcHistoryResult,
  OmpRpcMessagesPage
} from '../../shared/omp-rpc-protocol'
import { OmpRpcCommandError } from './omp-rpc-command-correlation'
import { OMP_RPC_MAX_MESSAGE_PAGE_LIMIT } from './omp-rpc-transport-limits'

export type OmpRpcHistoryFetchPage = (options: {
  cursor?: string
  limit?: number
}) => Promise<OmpRpcMessagesPage>

export type OmpRpcHistoryDrainOptions = {
  limit?: number
  /** Restarts allowed after a `stale_cursor`; each one discards the partial walk. */
  maxRestarts?: number
}

const DEFAULT_MAX_RESTARTS = 2

function pageErrorCode(error: unknown): string | undefined {
  return error instanceof OmpRpcCommandError ? error.code : undefined
}

/** One walk over a single upstream snapshot. Throws `stale_cursor` outward so the
 *  caller restarts from scratch — offsets shift when the snapshot moves, so a
 *  partial walk can never be spliced onto a newer one without gaps or duplicates. */
async function drainOneSnapshot(
  fetchPage: OmpRpcHistoryFetchPage,
  limit: number | undefined
): Promise<{ messages: OmpRpcHistoryMessage[]; totalMessages: number }> {
  const messages: OmpRpcHistoryMessage[] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  let expectedTotal: number | undefined

  for (;;) {
    const page = await fetchPage({
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit })
    })
    if (expectedTotal === undefined) {
      expectedTotal = page.totalMessages
    } else if (page.totalMessages !== expectedTotal) {
      throw new Error(
        `OMP RPC history page changed totalMessages mid-walk: ${expectedTotal} then ${page.totalMessages}`
      )
    }
    if (page.nextCursor !== undefined && page.messages.length === 0) {
      throw new Error('OMP RPC history page made no progress but asked for another page')
    }
    messages.push(...page.messages)
    if (messages.length > expectedTotal) {
      throw new Error(
        `OMP RPC history overran totalMessages: ${messages.length} of ${expectedTotal}`
      )
    }
    if (page.nextCursor === undefined) {
      break
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new Error('OMP RPC history page repeated a cursor')
    }
    seenCursors.add(page.nextCursor)
    cursor = page.nextCursor
  }

  if (messages.length !== expectedTotal) {
    throw new Error(`OMP RPC history ended with ${messages.length} of ${expectedTotal} messages`)
  }
  return { messages, totalMessages: expectedTotal }
}

/**
 * Drains OMP's cursor-paginated `get_messages_page` into one snapshot-consistent
 * message list. The upstream cursor is bound to (sessionId, leafId, messageCount),
 * so the only safe response to `stale_cursor` is to throw the partial walk away
 * and start over; `session_busy` is reported rather than retried because upstream
 * refuses to page at all while streaming or compacting.
 */
export async function drainOmpRpcHistory(
  fetchPage: OmpRpcHistoryFetchPage,
  options: OmpRpcHistoryDrainOptions = {}
): Promise<OmpRpcHistoryResult> {
  const { limit, maxRestarts = DEFAULT_MAX_RESTARTS } = options
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) || limit < 1 || limit > OMP_RPC_MAX_MESSAGE_PAGE_LIMIT)
  ) {
    throw new Error(
      `OMP RPC history page limit must be between 1 and ${OMP_RPC_MAX_MESSAGE_PAGE_LIMIT}`
    )
  }

  for (let attempt = 0; attempt <= maxRestarts; attempt += 1) {
    try {
      return { kind: 'complete', ...(await drainOneSnapshot(fetchPage, limit)) }
    } catch (error) {
      const code = pageErrorCode(error)
      if (code === 'session_busy') {
        return { kind: 'session-busy' }
      }
      if (code !== 'stale_cursor') {
        throw error
      }
    }
  }
  throw new Error(
    `OMP RPC history kept restarting on a stale cursor after ${maxRestarts + 1} attempts`
  )
}
