import { afterEach, expect, it, vi } from 'vitest'
import { loadCodexReceiptHistory } from './codex-structured-thread-history-pages'

afterEach(() => vi.useRealTimers())

it('recovers every image from a turn whose full response exceeds the transport string budget', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000)
  const image = 'a'.repeat(10_000)
  const items = [
    { id: 'question', type: 'userMessage', text: 'Keep my images' },
    ...Array.from({ length: 40 }, (_, index) => ({
      id: `image-${index}`,
      type: 'imageGeneration',
      result: image,
      savedPath: `/images/${index}.png`
    })),
    { id: 'answer', type: 'agentMessage', text: 'All images saved' }
  ]
  const turn = {
    id: 'turn',
    rootTurnId: 'root',
    status: 'completed',
    startedAt: 1,
    completedAt: 2,
    error: null
  }
  const turns: Record<string, unknown>[] = []
  for await (const restored of loadCodexReceiptHistory({
    threadId: 'thread',
    signal: new AbortController().signal,
    deadline: 31_000,
    check: () => {},
    connection: {
      request: async (method, params) => {
        let response: unknown
        if (method === 'thread/turns/list') {
          response = {
            data: [
              {
                ...turn,
                itemsView: params?.itemsView,
                items: params?.itemsView === 'full' ? items : [items[0], items[41]]
              }
            ],
            nextCursor: null
          }
        } else if (method === 'thread/items/list') {
          const start = params?.cursor == null ? 0 : Number(params.cursor)
          const end = start + Number(params?.limit)
          response = {
            data: items.slice(start, end).map((item) => ({ turnId: 'turn', item })),
            nextCursor: end < items.length ? String(end) : null
          }
        } else {
          throw new Error(`Unexpected method: ${method}`)
        }
        // Small independent transport budget reproduces the oversized-frame boundary without a 512 MB fixture.
        if (Buffer.byteLength(JSON.stringify(response)) > 256_000) {
          throw new RangeError('Invalid string length')
        }
        return response
      }
    }
  })) {
    turns.push(restored)
  }
  expect(turns).toHaveLength(1)
  expect(turns[0]).toMatchObject({ ...turn, itemsView: 'full' })
  expect(turns[0]?.items).toEqual(items)
})
