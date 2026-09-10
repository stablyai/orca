import { describe, expect, it, vi } from 'vitest'
import type { OmpRpcHistoryMessage, OmpRpcMessagesPage } from '../../shared/omp-rpc-protocol'
import { OmpRpcCommandError } from './omp-rpc-command-correlation'
import { drainOmpRpcHistory, type OmpRpcHistoryFetchPage } from './omp-rpc-history-page'

function message(id: string): OmpRpcHistoryMessage {
  return { role: 'user', content: id }
}

/** A server that pages `messages` `limit` at a time, exactly as OMP does. */
function pagingServer(messages: OmpRpcHistoryMessage[], pageSize: number): OmpRpcHistoryFetchPage {
  return async ({ cursor }) => {
    const offset = cursor === undefined ? 0 : Number(cursor)
    const page = messages.slice(offset, offset + pageSize)
    const nextOffset = offset + page.length
    return {
      messages: page,
      ...(nextOffset < messages.length ? { nextCursor: String(nextOffset) } : {}),
      totalMessages: messages.length
    }
  }
}

describe('drainOmpRpcHistory', () => {
  it('drains every page in order with no gaps or duplicates', async () => {
    const messages = Array.from({ length: 7 }, (_, index) => message(`m${index}`))
    const fetchPage = vi.fn(pagingServer(messages, 3))

    const result = await drainOmpRpcHistory(fetchPage, { limit: 3 })

    expect(result).toEqual({ kind: 'complete', messages, totalMessages: 7 })
    expect(fetchPage).toHaveBeenCalledTimes(3)
    expect(fetchPage.mock.calls.map(([options]) => options.cursor)).toEqual([undefined, '3', '6'])
    expect(fetchPage.mock.calls.every(([options]) => options.limit === 3)).toBe(true)
  })

  it('completes in a single request when the first page is the whole history', async () => {
    const fetchPage = vi.fn(pagingServer([message('only')], 100))

    await expect(drainOmpRpcHistory(fetchPage)).resolves.toEqual({
      kind: 'complete',
      messages: [message('only')],
      totalMessages: 1
    })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('reports an empty history as complete', async () => {
    await expect(drainOmpRpcHistory(pagingServer([], 100))).resolves.toEqual({
      kind: 'complete',
      messages: [],
      totalMessages: 0
    })
  })

  it('reports session_busy without partial messages instead of throwing', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(() =>
      Promise.reject(
        new OmpRpcCommandError('Cannot page messages while the session is changing', 'session_busy')
      )
    )

    await expect(drainOmpRpcHistory(fetchPage)).resolves.toEqual({ kind: 'session-busy' })
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('does not merge pages across snapshots when a cursor goes stale mid-walk', async () => {
    const first = Array.from({ length: 4 }, (_, index) => message(`old${index}`))
    const second = Array.from({ length: 4 }, (_, index) => message(`new${index}`))
    let staleRaised = false
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async (options) => {
      if (!staleRaised && options.cursor !== undefined) {
        staleRaised = true
        throw new OmpRpcCommandError('RPC message cursor is stale', 'stale_cursor')
      }
      return pagingServer(staleRaised ? second : first, 2)(options)
    })

    const result = await drainOmpRpcHistory(fetchPage, { limit: 2 })

    // Only the post-restart snapshot survives: no `old*` message leaks in.
    expect(result).toEqual({ kind: 'complete', messages: second, totalMessages: 4 })
  })

  it('gives up when every restart attempt goes stale', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async (options) => {
      if (options.cursor !== undefined) {
        throw new OmpRpcCommandError('RPC message cursor is stale', 'stale_cursor')
      }
      return { messages: [message('a')], nextCursor: '1', totalMessages: 2 }
    })

    await expect(drainOmpRpcHistory(fetchPage, { limit: 1 })).rejects.toThrow(
      'OMP RPC history kept restarting on a stale cursor'
    )
  })

  it('rejects a page whose totalMessages moved without a stale cursor', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async (options) =>
      options.cursor === undefined
        ? { messages: [message('a')], nextCursor: '1', totalMessages: 2 }
        : { messages: [message('b')], totalMessages: 3 }
    )

    await expect(drainOmpRpcHistory(fetchPage)).rejects.toThrow(
      'OMP RPC history page changed totalMessages mid-walk'
    )
  })

  it('rejects a repeated cursor rather than accumulating duplicates', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async () => ({
      messages: [message('a')],
      nextCursor: 'same',
      totalMessages: 9
    }))

    await expect(drainOmpRpcHistory(fetchPage)).rejects.toThrow(
      'OMP RPC history page repeated a cursor'
    )
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('rejects an empty continuing page that would never make progress', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async (options) =>
      options.cursor === undefined
        ? { messages: [message('a')], nextCursor: '1', totalMessages: 4 }
        : { messages: [], nextCursor: '2', totalMessages: 4 }
    )

    await expect(drainOmpRpcHistory(fetchPage)).rejects.toThrow(
      'OMP RPC history page made no progress'
    )
  })

  it('rejects a walk that ends short of totalMessages', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async () => ({
      messages: [message('a')],
      totalMessages: 5
    }))

    await expect(drainOmpRpcHistory(fetchPage)).rejects.toThrow(
      'OMP RPC history ended with 1 of 5 messages'
    )
  })

  it('rejects a walk that overruns totalMessages', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(async (options) => ({
      messages: [message('a'), message('b')],
      ...(options.cursor === undefined ? { nextCursor: '2' } : {}),
      totalMessages: 3
    }))

    await expect(drainOmpRpcHistory(fetchPage)).rejects.toThrow(
      'OMP RPC history overran totalMessages'
    )
  })

  it('propagates a non-paging command failure untouched', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(() =>
      Promise.reject(new Error('OMP RPC client is not available'))
    )

    await expect(drainOmpRpcHistory(fetchPage)).rejects.toThrow('OMP RPC client is not available')
  })

  it('refuses a page limit outside the wire-documented range', async () => {
    const fetchPage = vi.fn<OmpRpcHistoryFetchPage>(
      async () =>
        ({
          messages: [],
          totalMessages: 0
        }) satisfies OmpRpcMessagesPage
    )

    await expect(drainOmpRpcHistory(fetchPage, { limit: 257 })).rejects.toThrow(
      'OMP RPC history page limit must be between 1 and 256'
    )
    await expect(drainOmpRpcHistory(fetchPage, { limit: 0 })).rejects.toThrow(
      'OMP RPC history page limit must be between 1 and 256'
    )
    expect(fetchPage).not.toHaveBeenCalled()
  })
})
