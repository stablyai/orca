import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../rpc/core'
import { readAgentConversation } from './agent-conversation-read'
import type { ResolvedAgentConversation } from './agent-conversation-address'
import { decodeReadCursor, encodeReadCursor } from './agent-read-cursor'
import type { AgentReadPartialRow } from '../../native-chat/agent-session-wire/publication/history/agent-read-row-progress'

const SESSION = 'codex_0b8f2a4e_6c1d_4f7a_9e3b_5a2c8d1f0e47'
const host = vi.hoisted(() => ({
  reads: { journalCursor: vi.fn(), agentReadPage: vi.fn() }
}))

vi.mock('../rpc/methods/structured-sessions/creation/structured-agent-session-gate', () => ({
  requireStructuredAgentAudience: () => undefined,
  requireInstalledStructuredHost: async () => host
}))
const terminal = vi.hoisted(() => ({
  source: vi.fn(),
  read: vi.fn()
}))
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { terminalAgentTranscriptSource: terminal.source }
}))
vi.mock('../orchestration/workers/transcripts/worker-transcript-read', () => ({
  canReadWorkerTranscript: () => true,
  readWorkerTranscript: terminal.read
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

function page(entries: string[], sequence: number, partial?: AgentReadPartialRow) {
  return {
    ok: true,
    entries: entries.map((text) => ({ kind: 'message', role: 'assistant', text })),
    next: { cursor: { epoch: 'e', sequence }, ...(partial ? { partial } : {}) },
    limited: partial !== undefined
  }
}

// Row 5 has three raw slots; the first is read.
const PARTIAL: AgentReadPartialRow = {
  row: 5,
  count: 3,
  fingerprint: 'AAAAAAAAAAAAAAAAAAAAAA',
  emitted: 'gA'
}
const legacy = (fields: Record<string, unknown>) =>
  `oar1_${Buffer.from(JSON.stringify({ v: 1, id: SESSION, s: 'chat', session: SESSION, journal: { epoch: 'e', sequence: 4 }, ...fields })).toString('base64url')}`
const current = (fields: Record<string, unknown>) =>
  `oar2_${Buffer.from(JSON.stringify({ v: 2, id: SESSION, s: 'chat', session: SESSION, journal: { epoch: 'e', sequence: 4 }, ...fields })).toString('base64url')}`

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

it.each([
  ['some', PARTIAL],
  ['none', { ...PARTIAL, emitted: 'AA' }]
])('carries a row read in part (%s of it emitted) to the next read', async (_, partial) => {
  host.reads.journalCursor.mockResolvedValue({ epoch: 'e', sequence: 4 })
  host.reads.agentReadPage.mockResolvedValueOnce(page(['first of three'], 4, partial))
  const first = await readAgentConversation(ctx, chat, { limit: 1 })
  host.reads.agentReadPage.mockResolvedValueOnce(page(['second of three'], 5))

  expect(first.cursor?.startsWith('oar2_')).toBe(true)
  await readAgentConversation(ctx, chat, { cursor: first.cursor!, limit: 2 })

  expect(host.reads.journalCursor).not.toHaveBeenCalled()
  expect(host.reads.agentReadPage).toHaveBeenLastCalledWith(SESSION, {
    limit: 2,
    after: { cursor: { epoch: 'e', sequence: 4 }, partial }
  })
})

it('reads a version 1 chat cursor at a row boundary, and refuses one inside a row', async () => {
  host.reads.journalCursor.mockResolvedValue({ epoch: 'e', sequence: 9 })
  host.reads.agentReadPage.mockResolvedValue(page(['next'], 9))

  await readAgentConversation(ctx, chat, { cursor: legacy({}) })
  expect(host.reads.agentReadPage).toHaveBeenLastCalledWith(SESSION, {
    limit: expect.any(Number),
    after: { cursor: { epoch: 'e', sequence: 4 } }
  })
  await expect(
    readAgentConversation(ctx, chat, { cursor: legacy({ w: 1 }) })
  ).rejects.toMatchObject({
    code: 'agent_read_cursor_invalid'
  })
})

it.each([
  ['a bitset longer than its slots', { ...PARTIAL, emitted: 'gAA' }],
  ['a set padding bit', { ...PARTIAL, emitted: 'gQ' }],
  ['a row at the frontier', { ...PARTIAL, row: 4 }],
  ['a negative slot count', { ...PARTIAL, count: -1 }],
  ['an unknown fingerprint form', { ...PARTIAL, fingerprint: 'short' }]
])('refuses a chat cursor with %s', async (_, partial) => {
  await expect(
    readAgentConversation(ctx, chat, { cursor: current({ partial }) })
  ).rejects.toMatchObject({
    code: 'agent_read_cursor_invalid'
  })
  expect(host.reads.agentReadPage).not.toHaveBeenCalled()
})

it("refuses another agent's cursor and a chat payload under the old prefix", async () => {
  const other = current({ id: 'claude_other' })
  await expect(readAgentConversation(ctx, chat, { cursor: other })).rejects.toMatchObject({
    code: 'agent_read_cursor_invalid'
  })
  const mislabeled = `oar1_${current({}).slice('oar2_'.length)}`
  await expect(readAgentConversation(ctx, chat, { cursor: mislabeled })).rejects.toMatchObject({
    code: 'agent_read_cursor_invalid'
  })
})

it('keeps transcript cursors on version 1', () => {
  const cursor = { v: 1, id: SESSION, s: 'transcript', i: 'source', p: 42, c: 'check' } as const

  const encoded = encodeReadCursor(cursor)

  expect(encoded.startsWith('oar1_')).toBe(true)
  expect(decodeReadCursor(encoded, SESSION)).toEqual(cursor)
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

it.each([
  ['heard without its WSL relay', '', 'without its WSL relay'],
  ['heard through its WSL relay', 'Ubuntu', null]
])(
  'reads a WSL terminal agent %s only when a distro was attested',
  async (_, wslDistro, refusal) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      terminal.source.mockResolvedValue({
        key: {
          executionHost: 'local',
          wslDistro,
          agent: 'claude',
          providerSessionId: 'p',
          locator: ''
        },
        providerSession: {
          id: 'p',
          transcriptPath: '/home/qa/.claude-custom/projects/repo/p.jsonl'
        },
        authority: 1
      })
      terminal.read.mockResolvedValue({ ok: false, reason: 'transcript_missing', warnings: [] })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the terminal read uses only the id and the mocked hook server and reader.
      const agent = {
        kind: 'terminal',
        orcaSessionId: 'claude_dd9b33e3'
      } as unknown as ResolvedAgentConversation

      const read = readAgentConversation(ctx, agent, {})

      if (refusal) {
        await expect(read).rejects.toThrow(refusal)
        expect(terminal.read).not.toHaveBeenCalled()
      } else {
        await expect(read).rejects.toThrow('transcript missing')
        expect(terminal.read).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Ubuntu' }))
      }
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  }
)
