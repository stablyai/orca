import { afterEach, expect, it, vi } from 'vitest'
import { loadCodexReceiptHistory } from './codex-structured-thread-history-pages'

afterEach(() => vi.useRealTimers())

// PR #44707: ordinary text receipt scans must retain page-level RPC cost.
it('recovers 1024 text turns within the existing eleven-page request budget', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1000)
  const turns = Array.from({ length: 1024 }, (_, index) => ({
    id: `turn-${index}`,
    itemsView: 'full',
    items: [{ id: `answer-${index}`, type: 'agentMessage', text: 'saved answer' }]
  }))
  let requests = 0
  const restored: unknown[] = []
  for await (const turn of loadCodexReceiptHistory({
    threadId: 'thread',
    signal: new AbortController().signal,
    deadline: 31_000,
    check: () => {},
    connection: {
      request: async (method, params) => {
        requests++
        if (method === 'thread/items/list') {
          const source = turns.find((value) => value.id === params?.turnId)
          return {
            data: source?.items.map((item) => ({ turnId: source.id, item })),
            nextCursor: null
          }
        }
        const start = params?.cursor == null ? 0 : Number(params.cursor)
        const end = start + Number(params?.limit)
        return {
          data: turns.slice(start, end),
          nextCursor: end < turns.length ? String(end) : null
        }
      }
    }
  })) {
    restored.push(turn)
  }
  expect(restored).toHaveLength(1024)
  expect(requests).toBe(11)
})
