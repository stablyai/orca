import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../rpc/core'
import { readAgentConversation } from './agent-conversation-read'
import type { ResolvedAgentConversation } from './agent-conversation-address'

const SESSION = 'codex_0b8f2a4e_6c1d_4f7a_9e3b_5a2c8d1f0e47'
const host = vi.hoisted(() => ({
  reads: { journalCursor: vi.fn(), agentReadPage: vi.fn() }
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

function page(entries: string[], sequence: number, within = 0, limited = false) {
  return {
    ok: true,
    entries: entries.map((text) => ({ kind: 'message', role: 'assistant', text })),
    next: { cursor: { epoch: 'e', sequence }, within },
    limited
  }
}

beforeEach(() => {
  host.reads.agentReadPage.mockReset()
  host.reads.journalCursor.mockReset()
})

it.each([20_000, 200_000])(
  'follows an unchanged chat of %i rows without reading its journal',
  async (rows) => {
    host.reads.journalCursor.mockResolvedValue({ epoch: 'e', sequence: rows })
    host.reads.agentReadPage.mockResolvedValue(page([`reply ${rows}`], rows))
    const first = await readAgentConversation(ctx, chat, { limit: 1 })
    host.reads.agentReadPage.mockClear()

    for (let read = 0; read < 10; read++) {
      const again = await readAgentConversation(ctx, chat, { cursor: first.cursor! })
      expect(again).toMatchObject({ entries: [], cursor: first.cursor })
    }

    expect(host.reads.agentReadPage).not.toHaveBeenCalled()
  }
)

it('carries a position inside a journal row from one read to the next', async () => {
  host.reads.agentReadPage.mockResolvedValueOnce(page(['first of pair'], 4, 1, true))
  const first = await readAgentConversation(ctx, chat, { limit: 1 })
  host.reads.agentReadPage.mockResolvedValueOnce(page(['second of pair'], 5))

  await readAgentConversation(ctx, chat, { cursor: first.cursor!, limit: 1 })

  expect(host.reads.journalCursor).not.toHaveBeenCalled()
  expect(host.reads.agentReadPage).toHaveBeenLastCalledWith(SESSION, {
    limit: 1,
    after: { cursor: { epoch: 'e', sequence: 4 }, within: 1 }
  })
})

it('takes a cursor ahead of the journal to the reader, not as an empty read', async () => {
  host.reads.journalCursor.mockResolvedValue({ epoch: 'e', sequence: 100 })
  host.reads.agentReadPage.mockResolvedValueOnce(page([], 1_100))
  const ahead = await readAgentConversation(ctx, chat, { limit: 1 })
  host.reads.agentReadPage.mockResolvedValueOnce({ ok: false })

  await expect(readAgentConversation(ctx, chat, { cursor: ahead.cursor! })).rejects.toMatchObject({
    code: 'agent_read_source_changed'
  })
})
