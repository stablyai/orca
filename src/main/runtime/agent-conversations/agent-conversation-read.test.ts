import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../rpc/core'
import { readAgentConversation } from './agent-conversation-read'
import type { ResolvedAgentConversation } from './agent-conversation-address'

const SESSION = 'codex_0b8f2a4e_6c1d_4f7a_9e3b_5a2c8d1f0e47'
const host = vi.hoisted(() => ({
  reads: { journalCursor: vi.fn() },
  history: vi.fn()
}))

vi.mock('../rpc/methods/structured-sessions/creation/structured-agent-session-gate', () => ({
  requireStructuredAgentAudience: () => undefined,
  requireInstalledStructuredHost: async () => host
}))
vi.mock('../orchestration/addressing/session-lineage/structured-session-lineage', () => ({
  resolveLineageRunningSession: () => ({ kind: 'here', sessionId: SESSION })
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat read reads only the record's id and agent.
const chat = {
  kind: 'chat',
  orcaSessionId: SESSION,
  record: { sessionId: SESSION, provider: 'codex' },
  store: {}
} as unknown as ResolvedAgentConversation
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the chat branch passes the context only to the mocked gates.
const ctx = {} as RpcContext

function message(sequence: number) {
  return {
    itemId: `item-${sequence}`,
    sequence,
    body: {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: `reply ${sequence}` }]
    }
  }
}

function page(items: ReturnType<typeof message>[], newest: number, more: boolean) {
  return {
    ok: true,
    page: {
      items,
      hasOlder: true,
      hasNewer: more,
      window: { oldest: null, newest: null, nextCursor: { epoch: 'e', sequence: newest } },
      liveCursor: { epoch: 'e', sequence: newest }
    }
  }
}

beforeEach(() => {
  host.history.mockReset()
  host.reads.journalCursor.mockReset()
})

it.each([20_000, 200_000])(
  'follows an unchanged chat of %i rows with no history read',
  async (rows) => {
    host.reads.journalCursor.mockResolvedValue({ epoch: 'e', sequence: rows })
    host.history.mockResolvedValue(page([message(rows)], rows, false))
    const first = await readAgentConversation(ctx, chat, { limit: 1 })
    host.history.mockClear()

    for (let read = 0; read < 10; read++) {
      const again = await readAgentConversation(ctx, chat, { cursor: first.cursor! })
      expect(again).toMatchObject({ entries: [], cursor: first.cursor })
    }

    expect(host.history).not.toHaveBeenCalled()
  }
)

it('gives a cursor read at most --limit entries and continues where it stopped', async () => {
  host.reads.journalCursor.mockResolvedValue({ epoch: 'e', sequence: 300 })
  host.history.mockResolvedValueOnce(page([], 100, false))
  const start = await readAgentConversation(ctx, chat, { limit: 1 })
  host.history.mockResolvedValueOnce(page([message(101)], 101, true))

  const next = await readAgentConversation(ctx, chat, { cursor: start.cursor!, limit: 1 })

  expect(host.history).toHaveBeenLastCalledWith({
    sessionId: SESSION,
    direction: 'after',
    cursor: { epoch: 'e', sequence: 100 },
    limit: 1
  })
  expect(next.entries).toEqual([{ kind: 'message', role: 'assistant', text: 'reply 101' }])
  expect(next.limited).toBe(true)
})
