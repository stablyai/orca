import { describe, expect, it, vi } from 'vitest'
import type { CodexAppServerConnection } from './codex-app-server-connection'
import { openCodexThread } from './codex-structured-thread-open'
import { verifyCodexForkedHistory } from './codex-structured-fork-history'

const fork = {
  source: { provider: 'codex', threadId: 'parent' },
  throughId: 'kept',
  retainedItemIds: ['codex:parent:kept:0']
} as const

type ForkRequest = CodexAppServerConnection['request']

// `verifyCodexForkedHistory` only ever calls `request`; the cast is confined to this one helper.
function forkConnection(request: ForkRequest): CodexAppServerConnection {
  return { request } as unknown as CodexAppServerConnection
}

describe('Codex retained fork history', () => {
  it.each(['kept', 'rewritten'])(
    'cross-checks the fork response against turns/list (%s)',
    async (turnId) => {
      const request = vi.fn(async (method: string) => {
        if (method === 'thread/fork') {
          return { thread: { id: 'child', forkedFromId: 'parent', turns: [] } }
        }
        if (method === 'thread/turns/list') {
          return { data: [{ id: turnId }], nextCursor: null }
        }
        return {
          data: [
            {
              turnId,
              item: { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'Kept' }] }
            }
          ],
          nextCursor: null
        }
      })
      const connection = forkConnection(request)
      const opened = await openCodexThread(
        connection,
        { cwd: '/workspace', resumeThreadId: 'parent' },
        100,
        fork
      )
      const proof = verifyCodexForkedHistory(connection, opened.threadId, fork, 100)
      await (turnId === 'kept'
        ? expect(proof).resolves.toBeUndefined()
        : expect(proof).rejects.toThrow('proof-mismatch'))
      expect(request).toHaveBeenCalledWith(
        'thread/turns/list',
        expect.objectContaining({ threadId: 'child' }),
        { timeoutMs: 100 }
      )
    }
  )

  it('accepts a fork whose thread holds turns the bounded journal never retained', async () => {
    // Orca journaled only `kept`; the provider thread still carries the compacted-away turn.
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/fork') {
        return { thread: { id: 'child', forkedFromId: 'parent', turns: [] } }
      }
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'kept' }, { id: 'compacted-away' }], nextCursor: null }
      }
      return {
        data: [
          {
            turnId: 'kept',
            item: { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'Kept' }] }
          },
          {
            turnId: 'compacted-away',
            item: { id: 'item-0', type: 'userMessage', content: [{ type: 'text', text: 'Old' }] }
          }
        ],
        nextCursor: null
      }
    })
    const connection = forkConnection(request)
    const opened = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'parent' },
      100,
      fork
    )
    await expect(
      verifyCodexForkedHistory(connection, opened.threadId, fork, 100)
    ).resolves.toBeUndefined()
  })

  it('refuses a fork that kept a turn past the selected one', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/fork') {
        return { thread: { id: 'child', forkedFromId: 'parent', turns: [] } }
      }
      if (method === 'thread/turns/list') {
        return { data: [{ id: 'later' }, { id: 'kept' }], nextCursor: null }
      }
      return {
        data: [
          {
            turnId: 'kept',
            item: { id: 'item-1', type: 'userMessage', content: [{ type: 'text', text: 'Kept' }] }
          }
        ],
        nextCursor: null
      }
    })
    const connection = forkConnection(request)
    const opened = await openCodexThread(
      connection,
      { cwd: '/workspace', resumeThreadId: 'parent' },
      100,
      fork
    )
    await expect(verifyCodexForkedHistory(connection, opened.threadId, fork, 100)).rejects.toThrow(
      'proof-mismatch'
    )
  })
})
