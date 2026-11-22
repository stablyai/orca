import { environmentManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItemDetails } from '../../../../../../src/shared/github/work-items/work-item-types'
import { hostQueryKey } from '../../../../query/host-query-key'
import { stubRpcClient } from '../../../../transport/rpc/rpc-client-test-stub'
import type { RpcResponse } from '../../../../transport/rpc/rpc-wire-types'
import { prDetailsQuery } from '../mobile-pr-queries'
import { pollPrComments, usePrCommentPolling } from './pr-comment-polling'

const target = { exec: 'local' as const, worktree: 'repo::/checkout' }
const input = { owner: 'acme', name: 'fork', host: 'github.example.com', number: 42 }
const key = hostQueryKey('desktop', prDetailsQuery.family, target, input)
const details: GitHubWorkItemDetails = {
  item: {
    id: 'pr:42',
    type: 'pr',
    number: 42,
    title: 'Example PR',
    state: 'open',
    url: 'https://github.example.com/acme/fork/pull/42',
    labels: [],
    updatedAt: '2026-11-22T00:00:00Z',
    author: null
  },
  body: 'Original description',
  comments: []
}

const commentsReply = {
  id: 'comments',
  ok: true,
  _meta: { runtimeId: 'desktop' },
  result: [{ id: 7, author: 'reviewer', body: 'New reply' }]
} satisfies RpcResponse

function commentClient(reply: () => Promise<RpcResponse>) {
  return stubRpcClient({
    sendRequest: async (method, params) => {
      if (method !== 'github.prComments') {
        throw new Error(`Unexpected read: ${method}`)
      }
      expect(params).toMatchObject({
        prNumber: 42,
        prRepo: { owner: 'acme', repo: 'fork', host: 'github.example.com' }
      })
      return reply()
    }
  })
}

describe('pollPrComments', () => {
  it('refreshes the conversation without marking the description fresh', async () => {
    const queryClient = new QueryClient()
    const serverEnvironment = environmentManager.isServer()
    const host = { hostId: 'desktop', client: commentClient(async () => commentsReply) }
    let renderer: ReturnType<typeof create> | undefined
    function Comments(): null {
      usePrCommentPolling(host, target, input, 100, () => false)
      return null
    }
    environmentManager.setIsServer(() => false)
    vi.useFakeTimers()
    try {
      queryClient.setQueryData(key, details, { updatedAt: 123 })
      await act(async () => {
        renderer = create(
          createElement(QueryClientProvider, { client: queryClient }, createElement(Comments))
        )
      })
      expect(queryClient.getQueryData(key)).toMatchObject({ comments: [] })
      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(queryClient.getQueryData(key)).toMatchObject({
        body: 'Original description',
        comments: [{ id: 7, body: 'New reply' }]
      })
      expect(queryClient.getQueryState(key)?.dataUpdatedAt).toBe(123)
    } finally {
      act(() => renderer?.unmount())
      queryClient.clear()
      vi.useRealTimers()
      environmentManager.setIsServer(() => serverEnvironment)
    }
  })

  it('keeps a later full refresh when the narrow read settles out of order', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData(key, details)
    try {
      const reply = Promise.withResolvers<RpcResponse>()
      const poll = pollPrComments(
        queryClient,
        commentClient(() => reply.promise),
        'desktop',
        target,
        input,
        new AbortController().signal,
        () => false
      )
      queryClient.setQueryData(key, { ...details, body: 'Newer description', comments: [] })
      reply.resolve(commentsReply)
      await poll
      expect(queryClient.getQueryData(key)).toMatchObject({
        body: 'Newer description',
        comments: []
      })
    } finally {
      queryClient.clear()
    }
  })
})
