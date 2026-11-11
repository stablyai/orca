import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../rpc/core'
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
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message)
    }
    return response
  })
  return client
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

/** Lets the command's next checks run until it prints, then surfaces its result or failure. */
async function settle(command: Promise<void>, logs: string[]): Promise<void> {
  for (let second = 0; second < 10 && logs.length === 0; second += 1) {
    await vi.advanceTimersByTimeAsync(1_000)
  }
  await command
}

describe('chat send --wait over the real host', () => {
  it('returns the completed turn when the host lacks agentSession.workState', async () => {
    harness = await openStructuredCodexRpcHarness(
      [],
      {},
      { localCli: true, omitMethods: ['agentSession.workState'] }
    )
    await harness.ok('agentSession.create', harness.createIntentParams())
    const client = cliClient(harness)
    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => logs.push(line))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
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
    await vi.advanceTimersByTimeAsync(1_000)
    harness.codex.notify('turn/completed', {
      threadId: THREAD,
      turn: { id: TURN, status: 'completed' }
    })
    await settle(sending, logs)
    expect(JSON.parse(logs.join('\n')).result).toMatchObject({
      delivery: 'submitted',
      settled: 'done',
      entries: [{ text: 'Older reply 0.' }, { text: `${NEWEST_MARKER} ${'x'.repeat(16)}` }]
    })
  })
})
