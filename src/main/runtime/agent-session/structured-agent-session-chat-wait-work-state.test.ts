import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../rpc/core'
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

describe('chat send --wait over the real host', () => {
  it('returns SQL work state when an attached chat projection is invalidated', async () => {
    harness = await openStructuredCodexRpcHarness([], {}, { localCli: true })
    await harness.ok('agentSession.create', harness.createIntentParams())
    await seedRunningTurn(1, 16)
    vi.spyOn(StructuredAgentSessionJournalProjections.prototype, 'readSql').mockResolvedValue(null)
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
    expect(
      await harness.call('agentSession.history', {
        sessionId: SESSION,
        direction: 'tail',
        limit: 1
      })
    ).toMatchObject({ ok: true, result: { page: { working: true } } })
  })

  it('returns the completed turn when the host lacks agentSession.workState', async () => {
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
    expect(JSON.parse(logs.join('\n')).result).toMatchObject({
      delivery: 'submitted',
      settled: 'done',
      entries: [{ text: 'Older reply 0.' }, { text: `${NEWEST_MARKER} ${'x'.repeat(16)}` }]
    })
  })
})
