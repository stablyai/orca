// `orca chat send --wait` through the real host: each check while the turn runs reads only work
// state, never a history page, a running-turn scan or the turn's text.

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../rpc/core'
import type * as HistoryPage from '../../native-chat/agent-session-wire/publication/history/agent-session-history-page'
import type * as LiveTurn from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { StructuredAgentSessionJournalProjections } from '../../native-chat/agent-session-wire/observations/structured-agent-session-status-journal-projection'
import { AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY } from '../../../shared/agent-session/agent-session-runtime-capabilities'
import { RuntimeClient, RuntimeClientError } from '../../../cli/runtime-client'
import { CHAT_HANDLERS } from '../../../cli/handlers/chat'
import {
  openStructuredCodexRpcHarness,
  SESSION,
  THREAD,
  TURN,
  type StructuredCodexRpcHarness
} from '../rpc/methods/structured-sessions/structured-codex-session-rpc-test-harness'

const work = vi.hoisted(() => ({ historyPages: 0, turnScans: 0 }))

vi.mock(
  '../../native-chat/agent-session-wire/publication/history/agent-session-history-page',
  async (importOriginal) => {
    const actual = await importOriginal<typeof HistoryPage>()
    return {
      ...actual,
      readAgentSessionHistory: (...args: Parameters<typeof actual.readAgentSessionHistory>) => {
        work.historyPages += 1
        return actual.readAgentSessionHistory(...args)
      }
    }
  }
)

vi.mock(
  '../../../shared/agent-session/view/structured-agent-session-live-turn',
  async (importOriginal) => {
    const actual = await importOriginal<typeof LiveTurn>()
    return {
      ...actual,
      runningStructuredAgentSessionTurnItemBySequence: (
        ...args: Parameters<typeof actual.runningStructuredAgentSessionTurnItemBySequence>
      ) => {
        work.turnScans += 1
        return actual.runningStructuredAgentSessionTurnItemBySequence(...args)
      }
    }
  }
)

const NEWEST_MARKER = 'newest-row-marker'

let harness: StructuredCodexRpcHarness | undefined

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await harness?.dispose()
  harness = undefined
})

/** The CLI's own client, answered by the host's dispatcher in the local CLI's caller context. */
function cliClient(open: StructuredCodexRpcHarness) {
  const client = new RuntimeClient('/tmp/orca-chat-wait-test', 60_000, null, null)
  const replies: { method: string; json: string }[] = []
  const onReply = new Set<() => void>()
  vi.spyOn(client, 'getCliStatus').mockResolvedValue({
    id: 'status',
    ok: true,
    result: {
      app: { running: true, pid: 1 },
      runtime: {
        state: 'ready',
        reachable: true,
        runtimeId: 'runtime-1',
        capabilities: [AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY]
      },
      graph: { state: 'ready' }
    },
    _meta: { runtimeId: 'runtime-1' }
  })
  vi.spyOn(client, 'call').mockImplementation(async (method: string, params?: unknown) => {
    const response: RpcResponse = await open.call(method, params)
    replies.push({ method, json: JSON.stringify(response) })
    for (const notify of onReply) {
      notify()
    }
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message)
    }
    return response
  })
  const waitForReplies = (method: string, after: number, count: number) => {
    const completed = Promise.withResolvers<void>()
    const notify = () => {
      if (replies.slice(after).filter((reply) => reply.method === method).length >= count) {
        onReply.delete(notify)
        completed.resolve()
      }
    }
    onReply.add(notify)
    notify()
    return completed.promise
  }
  return { client, replies, waitForReplies }
}

function agentMessage(id: string, text: string): void {
  harness!.codex.notify('item/completed', {
    threadId: THREAD,
    turnId: TURN,
    item: { type: 'agentMessage', id, text }
  })
}

/** A running turn holding `rows` earlier replies and one newest reply of `newestBytes`. */
async function seedRunningTurn(rows: number, newestBytes: number): Promise<void> {
  harness!.codex.notify('turn/started', { threadId: THREAD, turn: { id: TURN } })
  for (let index = 0; index < rows; index += 1) {
    agentMessage(`older-${index}`, `Older reply ${index}.`)
  }
  agentMessage('newest', `${NEWEST_MARKER} ${'x'.repeat(newestBytes)}`)
  await vi.waitFor(async () => {
    const page = await harness!.call('agentSession.history', {
      sessionId: SESSION,
      direction: 'tail',
      limit: 1
    })
    expect(JSON.stringify(page)).toContain(NEWEST_MARKER)
  })
}

/** Runs `chat send --wait`, completes the turn after two checks, and returns what each check cost. */
async function sendAndWait(rows: number, newestBytes: number) {
  harness = await openStructuredCodexRpcHarness([], {}, { localCli: true })
  await harness.ok('agentSession.create', harness.createIntentParams())
  const { client, replies, waitForReplies } = cliClient(harness)
  const flags = new Map<string, string | boolean>([
    ['session', SESSION],
    ['text', 'Run the tests'],
    ['wait', true]
  ])
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
  const sending = CHAT_HANDLERS['chat send']!({ flags, client, cwd: '/tmp', json: true })
  await vi.waitFor(() =>
    expect(harness!.codex.live().calls.map((c) => c.method)).toContain('turn/start')
  )
  await seedRunningTurn(rows, newestBytes)
  const before = replies.length
  work.historyPages = 0
  work.turnScans = 0
  const checks = () => replies.slice(before).filter((r) => r.method === 'agentSession.workState')
  await Promise.race([waitForReplies('agentSession.workState', before, 2), sending])
  expect(checks()).toHaveLength(2)
  const during = { ...work, checks: checks().map((r) => r.json) }
  work.historyPages = 0
  harness.codex.notify('turn/completed', {
    threadId: THREAD,
    turn: { id: TURN, status: 'completed' }
  })
  await sending
  const printed: { result: { entries: unknown[] } } = JSON.parse(logs.join('\n'))
  return { during, finalPages: work.historyPages, result: printed.result }
}

describe('chat send --wait over the real host', () => {
  it('returns SQL work state when an attached chat projection is invalidated', async () => {
    harness = await openStructuredCodexRpcHarness([], {}, { localCli: true })
    await harness.ok('agentSession.create', harness.createIntentParams())
    await seedRunningTurn(1, 16)
    vi.spyOn(StructuredAgentSessionJournalProjections.prototype, 'readSql').mockResolvedValue(null)
    work.historyPages = 0
    const response = await harness.call('agentSession.workState', { sessionId: SESSION })
    expect(response).toMatchObject({
      ok: true,
      result: {
        working: true,
        actionablePrompt: false,
        queuedMessageIds: [],
        nextQueuedMessageId: null,
        fence: expect.any(Number)
      }
    })
    expect(work.historyPages).toBe(0)
  })

  it.each([
    { rows: 15, newestBytes: 64 * 1024 },
    { rows: 150, newestBytes: 640 * 1024 }
  ])(
    'checks a running turn without history pages, turn scans or its text ($rows rows, $newestBytes byte newest reply)',
    async ({ rows, newestBytes }) => {
      const { during, finalPages, result } = await sendAndWait(rows, newestBytes)
      expect(during.historyPages).toBe(0)
      expect(during.turnScans).toBe(0)
      for (const check of during.checks) {
        expect(check).not.toContain(NEWEST_MARKER)
        expect(JSON.parse(check).result).toEqual({
          working: true,
          actionablePrompt: false,
          queuedMessageIds: [],
          nextQueuedMessageId: null,
          fence: expect.any(Number)
        })
      }
      expect(finalPages).toBe(1)
      expect(result).toMatchObject({ delivery: 'submitted', settled: 'done', truncated: false })
      expect(result.entries).toEqual([
        ...Array.from({ length: rows }, (_, index) => ({
          kind: 'message',
          role: 'assistant',
          text: `Older reply ${index}.`
        })),
        { kind: 'message', role: 'assistant', text: `${NEWEST_MARKER} ${'x'.repeat(newestBytes)}` }
      ])
    }
  )

  it('reads history pages from a host without agentSession.workState, asking it only once', async () => {
    harness = await openStructuredCodexRpcHarness(
      [],
      {},
      { localCli: true, omitMethods: ['agentSession.workState'] }
    )
    await harness.ok('agentSession.create', harness.createIntentParams())
    const { client, replies, waitForReplies } = cliClient(harness)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
    const sending = CHAT_HANDLERS['chat send']!({
      flags: new Map<string, string | boolean>([
        ['session', SESSION],
        ['text', 'Run the tests'],
        ['wait', true]
      ]),
      client,
      cwd: '/tmp',
      json: true
    })
    await vi.waitFor(() =>
      expect(harness!.codex.live().calls.map((c) => c.method)).toContain('turn/start')
    )
    await seedRunningTurn(1, 16)
    await Promise.race([waitForReplies('agentSession.history', replies.length, 1), sending])
    harness.codex.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: TURN, status: 'completed' }
    })
    await sending
    expect(replies.filter((r) => r.method === 'agentSession.workState')).toHaveLength(1)
    expect(JSON.parse(logs.join('\n')).result).toMatchObject({
      delivery: 'submitted',
      settled: 'done',
      entries: [{ text: 'Older reply 0.' }, { text: `${NEWEST_MARKER} ${'x'.repeat(16)}` }]
    })
  })
})
